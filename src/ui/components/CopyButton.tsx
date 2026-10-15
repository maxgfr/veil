import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "./Icons";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** "Copy", then "Copied" for a moment once the clipboard has it. */
export function CopyButton(props: {
  text: string;
  class?: string;
  /** Id of what is copied, when "Copy" alone would be ambiguous (a row in a list). */
  describedby?: string;
  testid?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      class={props.class ?? "btn btn-secondary"}
      aria-describedby={props.describedby}
      data-testid={props.testid}
      onClick={async () => setCopied(await copyText(props.text))}
    >
      <Icon name={copied ? "check" : "copy"} size={18} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
