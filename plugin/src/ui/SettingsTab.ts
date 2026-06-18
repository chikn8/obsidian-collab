import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type CollabPlugin from "../main";

export class CollabSettingsTab extends PluginSettingTab {
  plugin: CollabPlugin;

  constructor(app: App, plugin: CollabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Real-Time Collaboration" });

    // ── Connection ───────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("WebSocket server address for Yjs sync.")
      .addText((text) =>
        text
          .setPlaceholder("wss://obsidiansync-production.up.railway.app")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Server Password")
      .setDesc("Global password for the legacy shared folder. Must match the server's AUTH_TOKEN.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter password")
          .setValue(this.plugin.settings.serverPassword)
          .onChange(async (value) => {
            this.plugin.settings.serverPassword = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Server Secret")
      .setDesc("Only needed to CREATE shares (mints per-folder keys). Leave blank if you only join others' shares. Must match the server's SERVER_SECRET.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter server secret")
          .setValue(this.plugin.settings.serverSecret)
          .onChange(async (value) => {
            this.plugin.settings.serverSecret = value;
            await this.plugin.saveSettings(false);
          });
      });

    // ── Identity ─────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Display Name")
      .setDesc("Shown to collaborators (and its first letter becomes your avatar).")
      .addText((text) =>
        text
          .setPlaceholder("Anonymous")
          .setValue(this.plugin.settings.displayName)
          .onChange(async (value) => {
            this.plugin.settings.displayName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Cursor / Avatar Color")
      .setDesc("Your color visible to others.")
      .addText((text) => {
        text.inputEl.type = "color";
        text.inputEl.style.width = "60px";
        text.inputEl.style.padding = "2px";
        text
          .setValue(this.plugin.settings.cursorColor)
          .onChange(async (value) => {
            this.plugin.settings.cursorColor = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("ntfy Topic (mentions)")
      .setDesc("Your ntfy.sh topic to receive @mention push notifications. Leave blank to disable.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. elijah-cli-xxxx")
          .setValue(this.plugin.settings.ntfyTopic)
          .onChange(async (value) => {
            this.plugin.settings.ntfyTopic = value.trim();
            await this.plugin.saveSettings(false);
          })
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Verbose console logs for bug-testing (open the dev console).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugLogging).onChange(async (v) => {
          this.plugin.settings.debugLogging = v;
          await this.plugin.saveSettings(false);
        })
      );

    new Setting(containerEl)
      .setName("Diagnostic trace file")
      .setDesc("Write redacted structured sync diagnostics to the vault for feedback-loop debugging.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.diagnosticLogging).onChange(async (v) => {
          this.plugin.settings.diagnosticLogging = v;
          await this.plugin.saveSettings(false);
        })
      );

    new Setting(containerEl)
      .setName("Diagnostics")
      .setDesc("Capture or export redacted sync events for debugging lost saves, loops, and presence glitches.")
      .addButton((b) =>
        b.setButtonText("Trace 2 min").onClick(() => {
          (this.app as any).commands?.executeCommandById?.("obsidian-collab:start-diagnostic-trace");
        })
      )
      .addButton((b) =>
        b.setButtonText("Export bundle").onClick(() => {
          (this.app as any).commands?.executeCommandById?.("obsidian-collab:export-diagnostic-bundle");
        })
      );

    // ── Shares ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Shared Folders" });

    new Setting(containerEl)
      .setName("Add a shared folder")
      .setDesc("Share one of your folders with someone, or join a folder someone shared with you.")
      .addButton((b) =>
        b.setButtonText("Share a folder…").onClick(async () => {
          await this.plugin.shareFolderInteractive();
          this.display();
        })
      )
      .addButton((b) =>
        b.setButtonText("Join with code…").setCta().onClick(async () => {
          await this.plugin.addShareFromCodeInteractive();
          this.display();
        })
      );

    if (this.plugin.settings.shares.length === 0) {
      containerEl.createEl("p", {
        text: "No shared folders yet.",
        cls: "setting-item-description",
      });
    }

    const canMint = !!this.plugin.settings.serverSecret;
    for (const share of this.plugin.settings.shares) {
      const role = share.role || "editor";
      const tags = [share.legacy ? "legacy" : null, role !== "editor" ? role : null].filter(Boolean).join(", ");
      const s = new Setting(containerEl)
        .setName(share.label + (tags ? `  (${tags})` : ""))
        .setDesc(share.localFolder);

      // Creator controls (need the server secret to mint role keys / revoke).
      if (!share.legacy && canMint) {
        s.addButton((b) =>
          b.setButtonText("Editor link").onClick(async () => {
            const code = await this.plugin.generateShareCode(share, "editor");
            if (code) await copyToClipboard(code, "Editor link copied");
          })
        );
        s.addButton((b) =>
          b.setButtonText("View-only link").onClick(async () => {
            const code = await this.plugin.generateShareCode(share, "viewer");
            if (code) await copyToClipboard(code, "View-only link copied");
          })
        );
        s.addButton((b) =>
          b.setButtonText("Revoke all").setWarning().onClick(async () => {
            await this.plugin.revokeShareAccess(share);
            this.display();
          })
        );
      }

      s.addButton((b) =>
        b
          .setButtonText(share.legacy ? "Stop" : "Leave")
          .setWarning()
          .onClick(async () => {
            await this.plugin.removeShare(share.id);
            this.display();
          })
      );
    }
  }
}

/** Copy text to the clipboard with a mobile-safe fallback (shows the code to copy by hand). */
async function copyToClipboard(text: string, okMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(okMsg);
  } catch {
    // Mobile webviews may block clipboard writes — surface the code instead.
    new Notice(`Copy this link manually:\n${text}`, 15000);
  }
}
