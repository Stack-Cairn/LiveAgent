package kbrain

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// K-brain's own question tool (Stack-Cairn/K-brain#162). Its call shows as the
// AskUserQuestion card and its plain-text result is read back into the card's
// answers, as the desktop does in crates/agent-ui/src/lib/chat/askUserQuestion.ts.
const (
	kbrainQuestionTool = "question"
	// kbrainRunDetailsKey carries how a shell tool ran (exit code, timeout,
	// duration) in tool-result details; crates/agent-ui/src/lib/chat/toolRunInfo.ts
	// reads it.
	kbrainRunDetailsKey = "kbrainRun"
	questionNoAnswer    = "(no answer)"
)

var (
	questionHeadingPattern = regexp.MustCompile(`^(\d+)\. `)
	questionAnswerPattern  = regexp.MustCompile(`^ {3}→ ?(.*)$`)
	questionCancelPattern  = regexp.MustCompile(`(?i)dismissed the question|stopped the turn|cancel`)
)

// toolResultName is the tool name the transcript shows for a K-brain result.
func toolResultName(name string) string {
	if name == kbrainQuestionTool {
		return askUserQuestionTool
	}
	return name
}

// normalizeQuestionToolArgs turns question arguments, in either of the tool's
// forms (question/options/multiple, or questions[]), into AskUserQuestion's
// questions[] with ids q1, q2, … where none is given and the text as prompt.
func normalizeQuestionToolArgs(args map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range args {
		if strings.HasPrefix(key, "__") {
			out[key] = value
		}
	}
	raw, _ := args["questions"].([]any)
	if len(raw) == 0 {
		raw = []any{map[string]any{"question": args["question"], "options": args["options"], "multiple": args["multiple"]}}
	}
	questions := make([]any, 0, len(raw))
	for index, value := range raw {
		question, ok := value.(map[string]any)
		if !ok {
			questions = append(questions, value)
			continue
		}
		item := make(map[string]any, len(question)+1)
		for key, field := range question {
			if key != "question" {
				item[key] = field
			}
		}
		if id := trimmedString(question["id"]); id != "" {
			item["id"] = id
		} else {
			item["id"] = fmt.Sprintf("q%d", index+1)
		}
		prompt := trimmedString(question["question"])
		if prompt == "" {
			prompt = trimmedString(question["prompt"])
		}
		item["prompt"] = prompt
		questions = append(questions, item)
	}
	out["questions"] = questions
	return out
}

func trimmedString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

type questionItem struct {
	id       string
	prompt   string
	labels   map[string]bool
	multiple bool
}

func questionItems(raw any) []questionItem {
	list, _ := raw.([]any)
	out := make([]questionItem, 0, len(list))
	for _, value := range list {
		question, ok := value.(map[string]any)
		if !ok {
			continue
		}
		item := questionItem{id: trimmedString(question["id"]), prompt: trimmedString(question["prompt"]), labels: map[string]bool{}}
		if item.prompt == "" {
			item.prompt = trimmedString(question["question"])
		}
		item.multiple, _ = question["multiple"].(bool)
		options, _ := question["options"].([]any)
		for _, option := range options {
			if record, ok := option.(map[string]any); ok {
				if label := trimmedString(record["label"]); label != "" {
					item.labels[label] = true
				}
			}
		}
		if item.id == "" || item.prompt == "" || len(item.labels) == 0 {
			continue
		}
		out = append(out, item)
	}
	return out
}

// questionAnswerTexts reads each question's answer from the question tool's
// result, in both of K-brain's spellings (tools.AskAnswerText); nil when the
// text is neither.
func questionAnswerTexts(questions []questionItem, output string) []string {
	text := strings.TrimSpace(output)
	const single = "User answered "
	if strings.HasPrefix(text, single) {
		prompt := ""
		if len(questions) > 0 {
			prompt = questions[0].prompt
		}
		exact := single + "\"" + prompt + "\": "
		start := len(exact)
		if !strings.HasPrefix(text, exact) {
			index := strings.Index(text, "\": ")
			if index < 0 {
				return nil
			}
			start = index + 3
		}
		return []string{strings.TrimSpace(text[start:])}
	}
	if !strings.HasPrefix(text, "The user answered:") {
		return nil
	}
	answers := make([]string, len(questions))
	current, inAnswer := -1, false
	lines := strings.Split(text, "\n")
	for _, line := range lines[1:] {
		heading := questionHeadingPattern.FindStringSubmatch(line)
		if heading != nil && !inAnswer {
			current, _ = strconv.Atoi(heading[1])
			current--
			continue
		}
		if answer := questionAnswerPattern.FindStringSubmatch(line); answer != nil && current >= 0 && current < len(answers) {
			answers[current] = answer[1]
			inAnswer = true
			continue
		}
		if heading != nil {
			current, _ = strconv.Atoi(heading[1])
			current--
			inAnswer = false
			continue
		}
		if inAnswer && current >= 0 && current < len(answers) {
			answers[current] += "\n" + line
		}
	}
	for i, answer := range answers {
		answer = strings.TrimSpace(answer)
		if answer == questionNoAnswer {
			answer = ""
		}
		answers[i] = answer
	}
	return answers
}

// questionToolResultDetails is the settled question card for a question tool
// result. A dismissed question fails the tool and shows as cancelled; no answer
// to any question (the deadline passed) shows as timed out. WebUI splits a
// multi-select answer's joined labels back into options.
func questionToolResultDetails(args map[string]any, output string, isError bool, recorded []QuestionAnswer) map[string]any {
	// The recorded call is already normalized; history holds the model's own form.
	rawQuestions := normalizeQuestionToolArgs(args)["questions"]
	questions := questionItems(rawQuestions)
	if len(questions) == 0 {
		return nil
	}
	// K-brain's question_answers (Stack-Cairn/K-brain#168) are exact, so they
	// win over the text written for the model; old sessions only have the text.
	if !isError && len(recorded) > 0 {
		byID := map[string]QuestionAnswer{}
		for _, answer := range recorded {
			if _, seen := byID[answer.QuestionID]; !seen {
				byID[answer.QuestionID] = answer
			}
		}
		answers := []any{}
		for _, question := range questions {
			if answer, ok := byID[question.id]; ok && (len(answer.SelectedLabels) > 0 || strings.TrimSpace(answer.SelectedLabel) != "") {
				prompt := answer.Prompt
				if prompt == "" {
					prompt = question.prompt
				}
				answers = append(answers, cardAnswer(answer, prompt, !question.multiple))
			}
		}
		if len(answers) > 0 {
			return map[string]any{"kind": "ask_user_question", "questions": rawQuestions, "answers": answers}
		}
	}
	if isError {
		if !questionCancelPattern.MatchString(output) {
			return nil
		}
		return map[string]any{"kind": "ask_user_question", "questions": rawQuestions, "answers": []any{}, "cancelled": true}
	}
	texts := questionAnswerTexts(questions, output)
	if texts == nil {
		return nil
	}
	answers := []any{}
	for i, question := range questions {
		if i >= len(texts) || texts[i] == "" {
			continue
		}
		item := map[string]any{"questionId": question.id, "prompt": question.prompt, "selectedLabel": texts[i]}
		if !question.multiple && !question.labels[texts[i]] {
			item["custom"] = true
		}
		answers = append(answers, item)
	}
	details := map[string]any{"kind": "ask_user_question", "questions": rawQuestions, "answers": answers}
	if len(answers) == 0 {
		details["timedOut"] = true
	}
	return details
}

// cardAnswer is a recorded answer as the question card reads it. Structured
// answers carry their labels (selectedLabels) and typed text (customText), and
// selectedLabel is all of them joined; a single-select question shows its one
// label. Old-style answers keep their text and custom flag.
func cardAnswer(answer QuestionAnswer, prompt string, single bool) map[string]any {
	item := map[string]any{"questionId": answer.QuestionID, "prompt": prompt}
	if len(answer.SelectedLabels) == 0 {
		item["selectedLabel"] = answer.SelectedLabel
		if answer.Custom {
			item["custom"] = true
		}
		return item
	}
	if single {
		item["selectedLabel"] = answer.SelectedLabels[0]
		return item
	}
	text := ""
	if answer.Custom {
		text = strings.TrimSpace(answer.SelectedLabel)
	}
	parts := append([]string{}, answer.SelectedLabels...)
	if text != "" {
		parts = append(parts, text)
		item["custom"], item["customText"] = true, text
	}
	item["selectedLabel"] = strings.Join(parts, ", ")
	item["selectedLabels"] = append([]string{}, answer.SelectedLabels...)
	return item
}

// decodeQuestionAnswers reads question_answers from a decoded event payload.
func decodeQuestionAnswers(raw any) []QuestionAnswer {
	if raw == nil {
		return nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var answers []QuestionAnswer
	if json.Unmarshal(data, &answers) != nil {
		return nil
	}
	return answers
}

// shellRunTools report an exit status; only their results carry run info.
var shellRunTools = map[string]bool{"Bash": true, "bash": true, "ManagedProcess": true, "ProcessWait": true, "ProcessStop": true}

// withRunInfo adds kbrainRun ({exitCode?, timedOut?, durationMs?}) to a shell
// tool's result details from K-brain's exit_code / timed_out / duration_ms.
func withRunInfo(name string, details map[string]any, exitCode *int, timedOut bool, durationMs int64) map[string]any {
	if !shellRunTools[name] {
		return details
	}
	info := map[string]any{}
	if exitCode != nil {
		info["exitCode"] = *exitCode
	}
	if timedOut {
		info["timedOut"] = true
	}
	if durationMs > 0 {
		info["durationMs"] = durationMs
	}
	if len(info) == 0 {
		return details
	}
	if details == nil {
		details = map[string]any{}
	}
	details[kbrainRunDetailsKey] = info
	return details
}
