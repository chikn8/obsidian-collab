import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type CollabPlugin from "../main";
import type { Role } from "../types";
import { encodeShareCode } from "../utils/roomName";
import { promptModal } from "./modals";

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
      .setName("Share admin token")
      .setDesc("Creates new shares through the server without storing SERVER_SECRET on this device. Must match SHARE_MINT_TOKEN.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter share admin token")
          .setValue(this.plugin.settings.shareMintToken)
          .onChange(async (value) => {
            this.plugin.settings.shareMintToken = value;
            await this.plugin.saveSettings(false);
          });
      });

    new Setting(containerEl)
      .setName("Legacy server secret")
      .setDesc("Deprecated fallback for older servers that cannot mint shares. Avoid storing SERVER_SECRET in client settings.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Avoid unless using an old server")
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
      .setName("Send error telemetry")
      .setDesc("Opt in to POST redacted error diagnostics to your collab server.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.clientTelemetry).onChange(async (v) => {
          this.plugin.settings.clientTelemetry = v;
          await this.plugin.saveSettings(false);
        })
      );

    new Setting(containerEl)
      .setName("Diagnostics")
      .setDesc("Capture or export redacted sync events for debugging lost saves, loops, and presence glitches.")
      .addButton((b) =>
        b.setButtonText("Trace 2 min").onClick(() => {
          this.plugin.startDiagnosticTraceInteractive();
        })
      )
      .addButton((b) =>
        b.setButtonText("Export bundle").onClick(() => {
          void this.plugin.exportDiagnosticBundleInteractive();
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

    const hasLegacyMint = !!this.plugin.settings.serverSecret;
    for (const share of this.plugin.settings.shares) {
      const role = share.role || "editor";
      const tags = [share.legacy ? "legacy" : null, role !== "editor" ? role : null].filter(Boolean).join(", ");
      const s = new Setting(containerEl)
        .setName(share.label + (tags ? `  (${tags})` : ""))
        .setDesc(share.localFolder);

      // Creator controls need either the scoped owner key or the legacy server secret.
      if (!share.legacy && (share.ownerKey || hasLegacyMint)) {
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
          b.setButtonText("Invite…").onClick(async () => {
            const res = await promptModal(this.app, {
              title: "Create invite",
              cta: "Create",
              fields: [
                { key: "recipient", label: "Recipient label", placeholder: "e.g. Mira laptop" },
                { key: "role", label: "Role", placeholder: "viewer, commenter, or editor", value: "editor" },
                { key: "maxDevices", label: "Max devices", placeholder: "1", value: "1" },
                { key: "expiresHours", label: "Expires in hours", placeholder: "Leave blank for no expiry" },
              ],
            });
            if (!res) return;
            const role = parseRole(res.role);
            if (!role) {
              new Notice("Role must be viewer, commenter, or editor.");
              return;
            }
            const hoursRaw = res.expiresHours.trim();
            const hours = hoursRaw ? Number(hoursRaw) : 0;
            if (hoursRaw && (!Number.isFinite(hours) || hours <= 0)) {
              new Notice("Expiry must be a positive number of hours.");
              return;
            }
            const maxDevicesRaw = (res.maxDevices || "1").trim();
            const maxDevices = maxDevicesRaw ? Number(maxDevicesRaw) : 1;
            if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10) {
              new Notice("Max devices must be a whole number from 1 to 10.");
              return;
            }
            const expiresAt = hours > 0 ? Date.now() + hours * 60 * 60_000 : undefined;
            const code = await this.plugin.generateShareInviteCode(share, role, res.recipient.trim(), expiresAt, maxDevices);
            if (code) await copyToClipboard(code, "Invite link copied");
            this.display();
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
          .setButtonText("Change folder…")
          .onClick(async () => {
            await this.plugin.changeShareLocalFolderInteractive(share.id);
            this.display();
          })
      );

      s.addButton((b) =>
        b
          .setButtonText(share.legacy ? "Stop" : "Leave")
          .setWarning()
          .onClick(async () => {
            await this.plugin.removeShare(share.id);
            this.display();
          })
      );

      const invites = (share.invites || []).filter((i) => i.id);
      for (const invite of invites) {
        const label = invite.recipient || invite.id;
        const meta = [
          invite.role,
          `${invite.maxDevices || 1} device${(invite.maxDevices || 1) === 1 ? "" : "s"}`,
          invite.expiresAt ? `expires ${new Date(invite.expiresAt).toLocaleString()}` : "no expiry",
          invite.revokedAt ? `revoked ${new Date(invite.revokedAt).toLocaleString()}` : null,
        ].filter(Boolean).join(" · ");
        const row = new Setting(containerEl)
          .setName(`Invite: ${label}`)
          .setDesc(meta);
        if (!invite.revokedAt && invite.key) {
          row.addButton((b) =>
            b.setButtonText("Copy").onClick(async () => {
              const code = encodeShareCode(
                this.plugin.settings.serverUrl,
                share.id,
                invite.key!,
                invite.role,
                share.epoch ?? 1,
                invite.id,
                invite.expiresAt,
                share.label
              );
              await copyToClipboard(code, "Invite link copied");
            })
          );
        }
        if (!invite.revokedAt && share.ownerKey) {
          row.addButton((b) =>
            b.setButtonText("Revoke").setWarning().onClick(async () => {
              await this.plugin.revokeShareInvite(share, invite);
              this.display();
            })
          );
        }
      }
    }
  }
}

function parseRole(value: string): Role | null {
  const v = value.trim().toLowerCase();
  return v === "viewer" || v === "commenter" || v === "editor" ? v : null;
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
