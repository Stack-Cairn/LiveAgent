package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// Relay maps Gateway identities to one K-brain target. Compatible backends own
// the queue; older backends retain the legacy relay executor until migration.
type Relay struct {
	client       *Client
	target       string
	defaultModel ModelRef
	createCWD    string

	mu              sync.Mutex
	sessions        map[string]string
	runs            map[string]*runState
	dedupe          map[string]string
	queues          map[string][]queuedRun
	queueRevisions  map[string]uint64
	queueEdits      map[string]queueEdit
	activeRuns      map[string]string
	queuePath       string
	backendQueue    bool
	backendRuns     map[string]backendQueueRun
	backendWatching map[string]bool
	backendSubmitMu sync.Mutex
	backendContext  context.Context
	backendCancel   context.CancelFunc
	backendWorkers  sync.WaitGroup
}

type runState struct {
	gatewayRunID      string
	conversationID    string
	clientRequestID   string
	kbrainSessionID   string
	kbrainRunID       string
	acceptedSeq       int64
	lastSeq           int64
	replaySeq         int64
	ctx               context.Context
	cancel            context.CancelFunc
	callbacks         Callbacks
	terminal          bool
	cancelRequested   bool
	cancelIssued      bool
	canonicalTerminal bool
	done              chan struct{}
	restored          bool
}

type queuedRun struct {
	RunID             string
	ConversationID    string
	ClientRequestID   string
	Prompt            PromptRequest
	CWD               string
	CreatedAt         int64
	Callbacks         Callbacks `json:"-"`
	DraftJSON         string
	UploadedFilesJSON string
}

type queueEdit struct {
	Item           queuedRun
	ConversationID string
	Index          int
	Revision       uint64
}

type QueueResponse struct {
	Accepted     bool
	Message      string
	SnapshotJSON string
	ItemJSON     string
	ErrorCode    string
	Revision     uint64
}

type Callbacks struct {
	OnEvent   func(gatewayRunID string, event *gatewayv2.ChatEvent)
	OnControl func(gatewayRunID string, control *gatewayv2.ChatControlEvent)
	OnQueue   func(conversationID string, snapshot string, revision uint64)
}

func NewRelay(client *Client, target string, defaultModel ModelRef, cwd string) (*Relay, error) {
	return newRelay(client, target, defaultModel, cwd, "", Callbacks{})
}

func NewRelayWithQueueState(client *Client, target string, defaultModel ModelRef, cwd, queuePath string, callbacks Callbacks) (*Relay, error) {
	return newRelay(client, target, defaultModel, cwd, queuePath, callbacks)
}

func newRelay(client *Client, target string, defaultModel ModelRef, cwd, queuePath string, callbacks Callbacks) (*Relay, error) {
	if client == nil {
		return nil, errors.New("kbrain relay client is required")
	}
	target = strings.TrimSpace(target)
	if target == "" {
		return nil, errors.New("kbrain relay target is required")
	}
	r := &Relay{
		client:          client,
		target:          target,
		defaultModel:    defaultModel,
		createCWD:       cwd,
		queuePath:       strings.TrimSpace(queuePath),
		sessions:        map[string]string{},
		runs:            map[string]*runState{},
		dedupe:          map[string]string{},
		queues:          map[string][]queuedRun{},
		queueRevisions:  map[string]uint64{},
		queueEdits:      map[string]queueEdit{},
		activeRuns:      map[string]string{},
		backendRuns:     map[string]backendQueueRun{},
		backendWatching: map[string]bool{},
	}
	r.backendContext, r.backendCancel = context.WithCancel(context.Background())
	if r.queuePath != "" {
		if err := r.restoreQueue(callbacks); err != nil {
			return nil, err
		}
		r.resumeRestoredRuns()
		if r.backendQueue {
			bindings := make([]backendQueueRun, 0, len(r.backendRuns))
			for _, binding := range r.backendRuns {
				bindings = append(bindings, binding)
			}
			for _, binding := range bindings {
				r.watchBackendQueuedRun(binding, callbacks)
			}
		}
	}
	return r, nil
}

func (r *Relay) Target() string { return r.target }

func (r *Relay) SettingsGet(ctx context.Context, request *gatewayv2.SettingsGetRequest) (*gatewayv2.SettingsGetResponse, error) {
	if request == nil {
		return nil, errors.New("settings get request is required")
	}
	raw, err := r.client.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	projected, err := settingsProjectionForGateway(raw)
	if err != nil {
		return nil, err
	}
	mcp, err := r.client.settingsRequest(ctx, "GET", "/v1/mcp", nil)
	if err != nil {
		return nil, err
	}
	var resource struct {
		Settings json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal(mcp, &resource); err != nil {
		return nil, err
	}
	validated, err := gatewayMCPSettings(resource.Settings)
	if err != nil {
		return nil, err
	}
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal(projected, &snapshot); err != nil {
		return nil, err
	}
	snapshot["mcp"] = validated
	skills, err := r.SkillManage(ctx, &gatewayv2.SkillManageRequest{PayloadJson: `{"action":"list"}`})
	if err != nil {
		return nil, err
	}
	var skillResource struct {
		Settings json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal([]byte(skills.GetResultJson()), &skillResource); err != nil {
		return nil, err
	}
	validatedSkills, err := gatewaySkillSettings(skillResource.Settings)
	if err != nil {
		return nil, err
	}
	snapshot["skills"] = validatedSkills
	var prompts struct {
		Templates json.RawMessage `json:"globalTemplates"`
	}
	if err := r.commandResource(ctx, "GET", "/v1/prompts", nil, &prompts); err != nil {
		return nil, err
	}
	if _, err := gatewayPromptTemplates(prompts.Templates); err != nil {
		return nil, err
	}
	snapshot["agents"] = prompts.Templates
	projected, err = json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	return &gatewayv2.SettingsGetResponse{SettingsJson: string(projected)}, nil
}

func (r *Relay) SettingsUpdate(ctx context.Context, request *gatewayv2.SettingsUpdateRequest) (*gatewayv2.SettingsUpdateResponse, error) {
	if request == nil {
		return nil, errors.New("settings update request is required")
	}
	args := json.RawMessage(strings.TrimSpace(request.GetSettingsJson()))
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	if !json.Valid(args) {
		return nil, errors.New("settings update payload is invalid JSON")
	}
	previous, err := r.client.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	translated, err := settingsUpdateForKBrain(args, previous)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(args, &fields); err != nil {
		return nil, err
	}
	var mcp json.RawMessage
	if value, ok := fields["mcp"]; ok {
		mcp, err = gatewayMCPSettings(value)
		if err != nil {
			return nil, err
		}
	}
	var skills json.RawMessage
	if value, ok := fields["skills"]; ok {
		skills, err = gatewaySkillSettings(value)
		if err != nil {
			return nil, err
		}
	}
	var templates json.RawMessage
	if value, ok := fields["agents"]; ok {
		templates, err = gatewayPromptTemplates(value)
		if err != nil {
			return nil, err
		}
	}
	if string(translated) != "{}" {
		if _, err := r.client.UpdateSettings(ctx, translated); err != nil {
			return nil, err
		}
	}
	if mcp != nil {
		if _, err := r.client.settingsRequest(ctx, "PUT", "/v1/mcp", mcp); err != nil {
			return nil, err
		}
	}
	if skills != nil {
		if _, err := r.client.settingsRequest(ctx, "PUT", "/v1/skills/settings", skills); err != nil {
			return nil, err
		}
	}
	if templates != nil {
		var result json.RawMessage
		if err := r.commandResource(ctx, "PUT", "/v1/prompts/templates", map[string]json.RawMessage{"templates": templates}, &result); err != nil {
			return nil, err
		}
	}
	return &gatewayv2.SettingsUpdateResponse{Accepted: true}, nil
}

func (r *Relay) ProviderList(ctx context.Context, request *gatewayv2.ProviderListRequest) (json.RawMessage, error) {
	if request == nil {
		return nil, errors.New("provider list request is required")
	}
	raw, err := r.client.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	document, err := decodeSettingsDocument(raw)
	if err != nil {
		return nil, err
	}
	providers := make([]any, 0, len(document.Providers))
	for _, provider := range document.Providers {
		providers = append(providers, providerPayload(provider))
	}
	return json.Marshal(map[string]any{"providers": providers})
}

func (r *Relay) ProviderModels(ctx context.Context, request *gatewayv2.ProviderModelsRequest) (*gatewayv2.ProviderModelsResponse, error) {
	if request == nil {
		return nil, errors.New("provider models request is required")
	}
	providerID := strings.TrimSpace(request.GetProviderId())
	if providerID == "" {
		providerID = "draft"
	}
	input := map[string]any{
		"providerId":     providerID,
		"type":           strings.TrimSpace(request.GetProviderType()),
		"baseUrl":        strings.TrimSpace(request.GetBaseUrl()),
		"apiKey":         strings.TrimSpace(request.GetApiKey()),
		"useSystemProxy": request.GetUseSystemProxy(),
		"modelsUrl":      strings.TrimSpace(request.GetModelsUrl()),
		"requestFormat":  strings.TrimSpace(request.GetRequestFormat()),
	}
	if request.IsFullUrl != nil {
		input["isFullUrl"] = request.GetIsFullUrl()
	}
	if headers := request.GetCustomHeaders(); headers != nil {
		items := make([]map[string]string, 0, len(headers.GetHeaders()))
		for _, header := range headers.GetHeaders() {
			items = append(items, map[string]string{"key": header.GetName(), "value": header.GetValue()})
		}
		input["customHeaders"] = items
	}
	models, err := r.client.DiscoverProviderModels(ctx, providerID, input)
	if err != nil {
		return nil, err
	}
	var document struct {
		Models []kbrainModel `json:"models"`
	}
	if err := json.Unmarshal(models, &document); err != nil || document.Models == nil {
		return nil, errors.New("malformed kbrain provider model discovery response")
	}
	projected := make([]any, 0, len(document.Models))
	for _, model := range document.Models {
		if strings.TrimSpace(model.ID) == "" {
			return nil, errors.New("kbrain discovery returned a model without an ID")
		}
		projected = append(projected, providerModel(kbrainProvider{ID: providerID}, model))
	}
	encoded, err := json.Marshal(projected)
	if err != nil {
		return nil, err
	}
	return &gatewayv2.ProviderModelsResponse{ModelsJson: string(encoded)}, nil
}

func (r *Relay) MemoryManage(ctx context.Context, request *gatewayv2.MemoryManageRequest) (*gatewayv2.MemoryManageResponse, error) {
	if request == nil {
		return nil, errors.New("memory manage request is required")
	}
	command := strings.TrimSpace(request.GetCommand())
	if command == "" {
		return nil, errors.New("memory command is required")
	}
	args := json.RawMessage(strings.TrimSpace(request.GetArgsJson()))
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	var (
		raw json.RawMessage
		err error
	)
	if command == "chat_history_search" {
		raw, err = r.client.HistorySearch(ctx, args)
	} else {
		raw, err = r.client.MemoryManage(ctx, command, args)
	}
	if err != nil {
		return nil, err
	}
	return &gatewayv2.MemoryManageResponse{ResultJson: string(raw)}, nil
}

func (r *Relay) CronManage(ctx context.Context, request *gatewayv2.CronManageRequest) (*gatewayv2.CronManageResponse, error) {
	if request == nil {
		return nil, errors.New("cron manage request is required")
	}
	raw, err := r.client.CronManage(ctx, request.GetAction(), request.GetTaskId(), request.GetTaskJson())
	if err != nil {
		return nil, err
	}
	return &gatewayv2.CronManageResponse{Action: request.GetAction(), ResultJson: string(raw)}, nil
}

func (r *Relay) Planning(ctx context.Context, request *gatewayv2.PlanningRequest) (*gatewayv2.PlanningResponse, error) {
	var input any
	if request.GetInputJson() != "" {
		if err := json.Unmarshal([]byte(request.GetInputJson()), &input); err != nil {
			return nil, err
		}
	}
	raw, err := r.client.cronRequest(ctx, "POST", "/v1/planning", map[string]any{"action": request.GetAction(), "input": input})
	if err != nil {
		return nil, err
	}
	return &gatewayv2.PlanningResponse{ResultJson: string(raw)}, nil
}

// Start accepts a run, queues it when the conversation is busy, and starts it
// asynchronously when the conversation is idle. The returned bool reports a
// duplicate or queued acceptance.
func (r *Relay) Start(ctx context.Context, gatewayRunID, conversationID, clientRequestID string, prompt PromptRequest, queuePolicy string, cb Callbacks) (bool, error) {
	return r.StartWithCWD(ctx, gatewayRunID, conversationID, clientRequestID, r.createCWD, prompt, queuePolicy, cb)
}

func (r *Relay) StartWithCWD(ctx context.Context, gatewayRunID, conversationID, clientRequestID, cwd string, prompt PromptRequest, queuePolicy string, cb Callbacks, composerCommand ...bool) (bool, error) {
	command := len(composerCommand) > 0 && composerCommand[0]
	if command {
		queuePolicy = "reject"
	}
	if r.usesBackendQueue() && !command {
		return r.startBackendQueuedRun(ctx, gatewayRunID, conversationID, clientRequestID, cwd, prompt, queuePolicy, cb)
	}
	gatewayRunID = strings.TrimSpace(gatewayRunID)
	conversationID = strings.TrimSpace(conversationID)
	clientRequestID = strings.TrimSpace(clientRequestID)
	if gatewayRunID == "" || conversationID == "" || strings.TrimSpace(prompt.Prompt) == "" {
		return false, errors.New("kbrain relay run identity and prompt are required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	prompt.ConversationID = conversationID
	prompt.ClientRequestID = clientRequestID
	if prompt.Model == nil || strings.TrimSpace(prompt.Model.Model) == "" {
		model := r.defaultModel
		prompt.Model = &model
	}
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		cwd = r.createCWD
	}

	var cancelActive *runState
	var cancelActiveWasRequested bool
	r.mu.Lock()
	before := r.queueStateCopyLocked()
	if clientRequestID != "" {
		if existingID := r.dedupe[conversationKey(conversationID, clientRequestID)]; existingID != "" {
			r.mu.Unlock()
			return true, nil
		}
	}
	if activeID := r.activeRuns[conversationID]; activeID != "" {
		policy := strings.TrimSpace(queuePolicy)
		if policy != "append" && policy != "auto" && policy != "interrupt" {
			r.mu.Unlock()
			return false, errors.New("kbrain conversation is already running")
		}
		item := queuedRun{RunID: gatewayRunID, ConversationID: conversationID, ClientRequestID: clientRequestID, Prompt: prompt, CWD: cwd, CreatedAt: time.Now().UnixMilli(), Callbacks: cb, DraftJSON: defaultDraftJSON(prompt.Prompt)}
		if policy == "interrupt" {
			r.queues[conversationID] = append([]queuedRun{item}, r.queues[conversationID]...)
			cancelActive = r.runs[activeID]
			if cancelActive != nil {
				cancelActiveWasRequested = cancelActive.cancelRequested
				cancelActive.cancelRequested = true
			}
		} else {
			r.queues[conversationID] = append(r.queues[conversationID], item)
		}
		if clientRequestID != "" {
			r.dedupe[conversationKey(conversationID, clientRequestID)] = gatewayRunID
		}
		r.bumpQueueRevisionLocked(conversationID)
		snapshot := r.queueResponseLocked(conversationID, r.queues[conversationID], r.queueRevisions[conversationID], "", nil)
		if err := r.persistQueueLocked(); err != nil {
			r.restoreQueueStateLocked(before)
			if cancelActive != nil {
				cancelActive.cancelRequested = cancelActiveWasRequested
			}
			r.mu.Unlock()
			return false, err
		}
		r.mu.Unlock()
		r.emitQueue(cb, conversationID, snapshot)
		if cancelActive != nil {
			r.requestCancel(context.Background(), cancelActive)
		}
		return true, nil
	}

	state, runCtx := r.newRunLocked(ctx, gatewayRunID, conversationID, clientRequestID, cb)
	if clientRequestID != "" {
		r.dedupe[conversationKey(conversationID, clientRequestID)] = gatewayRunID
	}
	r.activeRuns[conversationID] = gatewayRunID
	if err := r.persistQueueLocked(); err != nil {
		state.cancel()
		r.restoreQueueStateLocked(before)
		delete(r.runs, gatewayRunID)
		delete(r.activeRuns, conversationID)
		r.mu.Unlock()
		return false, err
	}
	r.mu.Unlock()
	go r.execute(runCtx, state, cwd, prompt)
	return false, nil
}

// Cancel cancels the selected running run or removes a queued run. Running
// cancellation reaches K-brain's real cancel endpoint when upstream IDs exist.
func (r *Relay) Cancel(ctx context.Context, conversationID, gatewayRunID string) (bool, error) {
	r.mu.Lock()
	localRun := r.runs[gatewayRunID] != nil || (gatewayRunID == "" && r.runs[r.activeRuns[conversationID]] != nil)
	r.mu.Unlock()
	if r.usesBackendQueue() && !localRun {
		return r.cancelBackendQueuedRun(ctx, conversationID, gatewayRunID)
	}
	conversationID = strings.TrimSpace(conversationID)
	gatewayRunID = strings.TrimSpace(gatewayRunID)
	if ctx == nil {
		ctx = context.Background()
	}

	var state *runState
	var queued *queuedRun
	var snapshot QueueResponse
	r.mu.Lock()
	before := r.queueStateCopyLocked()
	if gatewayRunID != "" {
		state = r.runs[gatewayRunID]
		if state != nil && conversationID != "" && state.conversationID != conversationID {
			state = nil
		}
	}
	if state == nil && conversationID != "" && (gatewayRunID == "" || r.activeRuns[conversationID] == gatewayRunID) {
		state = r.runs[r.activeRuns[conversationID]]
	}
	if state == nil && conversationID != "" {
		items := r.queues[conversationID]
		kept := items[:0]
		for i := range items {
			if queued == nil && (gatewayRunID == "" || items[i].RunID == gatewayRunID) {
				item := items[i]
				queued = &item
				continue
			}
			kept = append(kept, items[i])
		}
		if queued != nil {
			r.queues[conversationID] = kept
			if queued.ClientRequestID != "" {
				delete(r.dedupe, conversationKey(conversationID, queued.ClientRequestID))
			}
			revision := r.bumpQueueRevisionLocked(conversationID)
			snapshot = r.queueResponseLocked(conversationID, kept, revision, "", nil)
		}
	}
	if state != nil {
		wasRequested := state.cancelRequested
		state.cancelRequested = true
		if err := r.persistQueueLocked(); err != nil {
			state.cancelRequested = wasRequested
			r.mu.Unlock()
			return false, err
		}
		r.mu.Unlock()
		r.requestCancel(ctx, state)
		return true, nil
	}
	if queued != nil {
		if err := r.persistQueueLocked(); err != nil {
			r.restoreQueueStateLocked(before)
			r.mu.Unlock()
			return false, err
		}
		r.mu.Unlock()
		r.emitQueue(queued.Callbacks, queued.ConversationID, snapshot)
		r.emitTerminal(queued.RunID, queued.ConversationID, queued.Callbacks, "cancelled", "", "queued run cancelled")
		return true, nil
	}
	r.mu.Unlock()
	return false, nil
}

func (r *Relay) newRunLocked(ctx context.Context, gatewayRunID, conversationID, clientRequestID string, cb Callbacks) (*runState, context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	state := &runState{gatewayRunID: gatewayRunID, conversationID: conversationID, clientRequestID: clientRequestID, ctx: runCtx, cancel: cancel, callbacks: cb, done: make(chan struct{})}
	r.runs[gatewayRunID] = state
	return state, runCtx
}

func (r *Relay) requestCancel(ctx context.Context, state *runState) {
	if state == nil {
		return
	}
	r.mu.Lock()
	if state.canonicalTerminal || state.cancelIssued {
		r.mu.Unlock()
		return
	}
	state.cancelRequested = true
	sessionID, runID := state.kbrainSessionID, state.kbrainRunID
	if sessionID != "" && runID != "" {
		state.cancelIssued = true
	}
	r.mu.Unlock()
	if sessionID == "" || runID == "" {
		// The request may still be between session creation and acceptance. The
		// post-acceptance check in execute will issue the remote cancel.
		return
	}
	go func() {
		cancelCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = r.client.CancelRun(cancelCtx, sessionID, runID)
	}()
	// Keep SSE alive long enough for K-brain to publish run.cancelled. The
	// watchdog is only a bounded fallback for a backend that drops the event.
	go func() {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
			// Keep the reader alive so a later canonical cancellation can release
			// the active owner and dispatch the next queued item.
			r.emitTerminal(state.gatewayRunID, state.conversationID, r.runCallbacks(state), "cancelled", "cancel_timeout", "K-brain did not confirm cancellation")
		case <-state.done:
		}
	}()
}

func (r *Relay) execute(ctx context.Context, state *runState, cwd string, prompt PromptRequest) {
	gatewayRunID := state.gatewayRunID
	conversationID := state.conversationID
	cb := r.runCallbacks(state)
	defer func() {
		if errors.Is(ctx.Err(), context.Canceled) {
			r.emitTerminal(gatewayRunID, conversationID, cb, "cancelled", "", "")
		}
		state.cancel()
		r.finish(state)
	}()

	sessionID, err := r.session(ctx, conversationID, prompt.Model, cwd)
	if err != nil {
		if !errors.Is(ctx.Err(), context.Canceled) {
			r.emitTerminal(gatewayRunID, conversationID, cb, "failed", "kbrain_relay_error", err.Error())
		}
		return
	}
	r.mu.Lock()
	state.kbrainSessionID = sessionID
	r.mu.Unlock()

	prompt.ConversationID = sessionID
	accepted, status, err := r.client.StartRun(ctx, sessionID, prompt)
	if err != nil {
		if !errors.Is(ctx.Err(), context.Canceled) {
			if status == 409 {
				err = errors.New("kbrain session is already running")
				r.emitTerminal(gatewayRunID, conversationID, cb, "failed", "conversation_busy", err.Error())
				return
			}
			r.emitTerminal(gatewayRunID, conversationID, cb, "failed", "kbrain_relay_error", err.Error())
		}
		return
	}
	r.mu.Lock()
	state.kbrainRunID = accepted.RunID
	state.acceptedSeq = accepted.AcceptedSeq
	// accepted_seq is the sequence of run.accepted, so replay from the
	// preceding cursor. This remains correct when a session handles multiple
	// turns and accepted_seq is not reused.
	state.lastSeq = accepted.AcceptedSeq - 1
	state.replaySeq = state.lastSeq
	cancelled := state.cancelRequested || state.terminal
	persistErr := r.persistQueueLocked()
	r.mu.Unlock()
	if persistErr != nil {
		r.emitTerminal(gatewayRunID, conversationID, cb, "failed", "persistence_error", persistErr.Error())
		return
	}
	if cancelled {
		r.requestCancel(context.Background(), state)
	}
	readerCtx, cancelReader := context.WithCancel(ctx)
	defer cancelReader()
	for {
		err = r.client.EventsForRun(readerCtx, sessionID, r.currentSeq(state), accepted.RunID, func(event Event) error {
			if event.ConversationID != sessionID {
				return fmt.Errorf("kbrain event identity mismatch")
			}
			r.mu.Lock()
			if event.Seq <= state.lastSeq {
				r.mu.Unlock()
				return nil
			}
			if state.lastSeq > 0 && event.Seq != state.lastSeq+1 {
				expected := state.lastSeq + 1
				r.mu.Unlock()
				return fmt.Errorf("kbrain event sequence gap: expected %d got %d", expected, event.Seq)
			}
			previousSeq, previousReplay, previousTerminal := state.lastSeq, state.replaySeq, state.canonicalTerminal
			state.lastSeq = event.Seq
			terminal := isRunTerminal(event, accepted.RunID)
			if !terminal {
				state.replaySeq = event.Seq
			} else {
				state.canonicalTerminal = true
			}
			if err := r.persistQueueLocked(); err != nil {
				state.lastSeq, state.replaySeq, state.canonicalTerminal = previousSeq, previousReplay, previousTerminal
				r.mu.Unlock()
				return err
			}
			cb = state.callbacks
			r.mu.Unlock()
			if event.RunID != accepted.RunID {
				return nil
			}
			if event.Type == "permission.requested" {
				if err := r.client.rejectUnsupportedPermission(readerCtx, event); err != nil {
					return err
				}
			}
			mappedEvent := event
			mappedEvent.ConversationID = conversationID
			chat, control, mapErr := ToChatEvent(mappedEvent)
			if mapErr != nil {
				return mapErr
			}
			if chat != nil && cb.OnEvent != nil {
				cb.OnEvent(gatewayRunID, chat)
			}
			if control != nil {
				control.RequestId = gatewayRunID
				if control.Type == "completed" || control.Type == "failed" || control.Type == "cancelled" {
					r.emitTerminal(gatewayRunID, conversationID, cb, control.Type, control.ErrorCode, control.Message)
				} else {
					r.emitControl(gatewayRunID, cb, control)
				}
			}
			return nil
		})
		if err == nil || errors.Is(err, context.Canceled) {
			return
		}
		if !retryableEventStreamError(err) {
			r.emitTerminal(gatewayRunID, conversationID, cb, "failed", "kbrain_relay_error", err.Error())
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (r *Relay) emitControl(gatewayRunID string, cb Callbacks, control *gatewayv2.ChatControlEvent) {
	if cb.OnControl == nil || control == nil {
		return
	}
	cb.OnControl(gatewayRunID, control)
}

func (r *Relay) emitTerminal(gatewayRunID, conversationID string, cb Callbacks, status, errorCode, message string) {
	r.mu.Lock()
	state := r.runs[gatewayRunID]
	if state != nil {
		if state.terminal {
			r.mu.Unlock()
			return
		}
		state.terminal = true
		if state.done != nil {
			close(state.done)
		}
	}
	r.mu.Unlock()
	if cb.OnControl == nil {
		return
	}
	cb.OnControl(gatewayRunID, &gatewayv2.ChatControlEvent{RequestId: gatewayRunID, ConversationId: conversationID, Type: status, ErrorCode: errorCode, Message: message})
}

func (r *Relay) session(ctx context.Context, conversationID string, model *ModelRef, cwd string) (string, error) {
	r.mu.Lock()
	if id := r.sessions[conversationID]; id != "" {
		r.mu.Unlock()
		return id, nil
	}
	r.mu.Unlock()
	selected := r.defaultModel
	if model != nil && strings.TrimSpace(model.Model) != "" {
		selected = *model
	}
	if strings.TrimSpace(cwd) == "" {
		cwd = r.createCWD
	}
	id, err := r.client.CreateSession(ctx, cwd, selected)
	if err != nil {
		return "", err
	}
	r.mu.Lock()
	r.sessions[conversationID] = id
	if err := r.persistQueueLocked(); err != nil {
		delete(r.sessions, conversationID)
		r.mu.Unlock()
		return "", err
	}
	r.mu.Unlock()
	return id, nil
}

func (r *Relay) finish(state *runState) {
	r.mu.Lock()
	// A local error or timeout does not prove the backend session is idle.
	if !state.canonicalTerminal && state.kbrainRunID != "" {
		r.mu.Unlock()
		return
	}
	before := r.queueStateCopyLocked()
	if state.kbrainRunID == "" && state.clientRequestID != "" && r.dedupe[conversationKey(state.conversationID, state.clientRequestID)] == state.gatewayRunID {
		delete(r.dedupe, conversationKey(state.conversationID, state.clientRequestID))
	}
	delete(r.runs, state.gatewayRunID)
	wasActive := r.activeRuns[state.conversationID] == state.gatewayRunID
	if wasActive {
		delete(r.activeRuns, state.conversationID)
	}
	var next *queuedRun
	if wasActive {
		if items := r.queues[state.conversationID]; len(items) > 0 {
			item := items[0]
			r.queues[state.conversationID] = items[1:]
			revision := r.bumpQueueRevisionLocked(state.conversationID)
			snapshot := r.queueResponseLocked(state.conversationID, items[1:], revision, "", nil)
			next = &item
			if next.ClientRequestID != "" {
				r.dedupe[conversationKey(next.ConversationID, next.ClientRequestID)] = next.RunID
			}
			nextState, nextCtx := r.newRunLocked(context.Background(), next.RunID, next.ConversationID, next.ClientRequestID, next.Callbacks)
			r.activeRuns[next.ConversationID] = next.RunID
			if err := r.persistQueueLocked(); err != nil {
				nextState.cancel()
				delete(r.runs, next.RunID)
				r.restoreQueueStateLocked(before)
				r.runs[state.gatewayRunID] = state
				r.activeRuns[state.conversationID] = state.gatewayRunID
				r.mu.Unlock()
				return
			}
			r.mu.Unlock()
			go r.execute(nextCtx, nextState, next.CWD, next.Prompt)
			r.emitQueue(next.Callbacks, next.ConversationID, snapshot)
			return
		}
	}
	if err := r.persistQueueLocked(); err != nil {
		r.restoreQueueStateLocked(before)
		r.runs[state.gatewayRunID] = state
		if wasActive {
			r.activeRuns[state.conversationID] = state.gatewayRunID
		}
	}
	r.mu.Unlock()
}

func (r *Relay) currentSeq(state *runState) int64 {
	if state == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return state.lastSeq
}

// resumeRestoredRuns reconnects SSE for runs that were accepted before a
// Gateway restart. Queued items remain dormant until the restored backend run
// emits its canonical terminal event; finish then dispatches the next item.
func (r *Relay) resumeRestoredRuns() {
	r.mu.Lock()
	states := make([]*runState, 0)
	for _, state := range r.runs {
		if (state.restored || state.canonicalTerminal) && state.kbrainSessionID != "" && state.kbrainRunID != "" {
			states = append(states, state)
		}
	}
	r.mu.Unlock()
	for _, state := range states {
		go r.resumeRun(state)
	}
}

func (r *Relay) resumeRun(state *runState) {
	ctx := state.ctx
	defer state.cancel()
	// A cancellation request may have been persisted immediately before a
	// Gateway restart. Re-issue it before reconnecting so the recovered run
	// cannot remain busy solely because the original cancel goroutine vanished.
	r.mu.Lock()
	cancelRequested := state.cancelRequested
	r.mu.Unlock()
	if cancelRequested {
		r.requestCancel(ctx, state)
	}
	if state.canonicalTerminal {
		r.finish(state)
		return
	}
	readerCtx, cancelReader := context.WithCancel(ctx)
	defer cancelReader()
	for {
		terminalSeen := false
		err := r.client.EventsForRun(readerCtx, state.kbrainSessionID, r.currentSeq(state), state.kbrainRunID, func(event Event) error {
			if event.ConversationID != state.kbrainSessionID {
				return fmt.Errorf("restored K-brain event identity mismatch")
			}
			r.mu.Lock()
			if event.Seq <= state.lastSeq {
				r.mu.Unlock()
				return nil
			}
			if state.lastSeq > 0 && event.Seq != state.lastSeq+1 {
				expected := state.lastSeq + 1
				r.mu.Unlock()
				return fmt.Errorf("restored K-brain event sequence gap: expected %d got %d", expected, event.Seq)
			}
			previousSeq, previousReplay, previousTerminal := state.lastSeq, state.replaySeq, state.canonicalTerminal
			state.lastSeq = event.Seq
			terminal := isRunTerminal(event, state.kbrainRunID)
			if !terminal {
				state.replaySeq = event.Seq
			} else {
				state.canonicalTerminal = true
			}
			if err := r.persistQueueLocked(); err != nil {
				state.lastSeq, state.replaySeq, state.canonicalTerminal = previousSeq, previousReplay, previousTerminal
				r.mu.Unlock()
				return err
			}
			callbacks := state.callbacks
			r.mu.Unlock()
			if event.RunID != state.kbrainRunID {
				return nil
			}
			if event.Type == "permission.requested" {
				if err := r.client.rejectUnsupportedPermission(ctx, event); err != nil {
					return err
				}
			}
			mapped := event
			mapped.ConversationID = state.conversationID
			chat, control, mapErr := ToChatEvent(mapped)
			if mapErr != nil {
				return mapErr
			}
			if chat != nil && callbacks.OnEvent != nil {
				callbacks.OnEvent(state.gatewayRunID, chat)
			}
			if control != nil {
				control.RequestId = state.gatewayRunID
				if control.Type == "completed" || control.Type == "failed" || control.Type == "cancelled" {
					terminalSeen = true
					r.mu.Lock()
					state.restored = false
					callbacks = state.callbacks
					r.mu.Unlock()
					r.emitTerminal(state.gatewayRunID, state.conversationID, callbacks, control.Type, control.ErrorCode, control.Message)
				} else {
					r.emitControl(state.gatewayRunID, callbacks, control)
				}
			}
			return nil
		})
		if err == nil || errors.Is(err, context.Canceled) {
			if terminalSeen {
				r.finish(state)
			}
			return
		}
		if !retryableEventStreamError(err) {
			r.emitTerminal(state.gatewayRunID, state.conversationID, r.runCallbacks(state), "failed", "kbrain_relay_error", err.Error())
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (r *Relay) emitQueue(cb Callbacks, conversationID string, snapshot QueueResponse) {
	if cb.OnQueue != nil {
		cb.OnQueue(conversationID, snapshot.SnapshotJSON, snapshot.Revision)
	}
}

func conversationKey(conversationID, clientRequestID string) string {
	return conversationID + "\x00" + clientRequestID
}

func (r *Relay) runCallbacks(state *runState) Callbacks {
	r.mu.Lock()
	defer r.mu.Unlock()
	return state.callbacks
}

func isRunTerminal(event Event, runID string) bool {
	return event.RunID == runID && (event.Type == "run.completed" || event.Type == "run.failed" || event.Type == "run.cancelled")
}

// Transport failures can leave the canonical run active. Keep its reader alive
// until replay delivers the terminal event; protocol and callback errors remain fatal.
func retryableEventStreamError(err error) bool {
	var networkError net.Error
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &networkError)
}
