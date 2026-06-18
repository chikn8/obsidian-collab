import { App, Modal, Setting } from "obsidian";
import type { MentionUser } from "../utils/mentions";
import { wireMentionAutocomplete } from "./mentionInput";

/** Minimal single/multi-field prompt modal. Resolves to the values, or null if cancelled. */
export function promptModal(
  app: App,
  opts: {
    title: string;
    fields: { key: string; label: string; placeholder?: string; value?: string; mentionUsers?: MentionUser[] }[];
    cta?: string;
  }
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText(opts.title);
    const values: Record<string, string> = {};
    for (const f of opts.fields) values[f.key] = f.value ?? "";

    for (const f of opts.fields) {
      const setting = new Setting(modal.contentEl);
      setting
        .setName(f.label)
        .addText((t) => {
          t.setPlaceholder(f.placeholder ?? "").setValue(values[f.key]);
          t.onChange((v) => (values[f.key] = v));
          t.inputEl.style.width = "100%";
          if (f.mentionUsers) wireMentionAutocomplete(setting.settingEl, t.inputEl, () => f.mentionUsers ?? []);
        });
      if (f.mentionUsers) setting.settingEl.addClass("collab-mention-host");
    }

    let submitted = false;
    new Setting(modal.contentEl).addButton((b) =>
      b
        .setButtonText(opts.cta ?? "OK")
        .setCta()
        .onClick(() => {
          submitted = true;
          modal.close();
          resolve(values);
        })
    );

    modal.onClose = () => {
      if (!submitted) resolve(null);
    };
    modal.open();
  });
}
