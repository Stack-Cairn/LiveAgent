import { useLocale } from "@liveagent/ui/i18n/index";
import { truncateTextPreview } from "@liveagent/ui/lib/chat/textPreview";

/**
 * Inline text for a tool output `<pre>`: at most `maxChars` characters, followed by
 * a note in the UI locale when the rest was left out.
 */
export function TruncatedPreviewText({ text, maxChars }: { text: string; maxChars: number }) {
  const { locale, t } = useLocale();
  const preview = truncateTextPreview(text, maxChars);
  if (!preview.truncated) return <>{preview.text}</>;
  const format = new Intl.NumberFormat(locale);
  return (
    <>
      {preview.text}
      {"\n"}
      <span className="select-none text-muted-foreground/60" data-preview-truncated="">
        {t("chat.tool.output.truncated")
          .replace("{shown}", format.format(preview.text.length))
          .replace("{total}", format.format(preview.totalChars))}
      </span>
    </>
  );
}
