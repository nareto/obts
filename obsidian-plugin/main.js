const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:3000",
  pairingToken: "",
  deviceName: "",
  syncProfile: "notes_only",
  syncPlugins: false
};

module.exports = class ObtsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.status = this.addStatusBarItem();
    this.status.setText("obts: Checking");
    this.addSettingTab(new ObtsSettingTab(this.app, this));
    this.addCommand({
      id: "obts-sync-once",
      name: "Sync once",
      callback: async () => {
        new Notice("obts Phase 1 sync engine is provided by the packaged TypeScript client.");
        this.status.setText("obts: Blocked");
      }
    });
    this.addCommand({
      id: "obts-pair-device",
      name: "Pair device",
      callback: async () => {
        if (!this.settings.pairingToken) {
          new Notice("Enter a pairing token in obts settings first.");
          return;
        }
        new Notice("Pairing settings saved. Run the packaged client sync flow to consume the token.");
      }
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class ObtsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Obsidian True Sync" });

    new Setting(containerEl)
      .setName("Server URL")
      .addText((text) =>
        text.setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Pairing token")
      .addText((text) =>
        text.setValue(this.plugin.settings.pairingToken).onChange(async (value) => {
          this.plugin.settings.pairingToken = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Device name")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync profile")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("notes_only", "Notes only")
          .addOption("notes_plus_attachments", "Notes plus attachments")
          .addOption("full_vault_config", "Full vault config")
          .setValue(this.plugin.settings.syncProfile)
          .onChange(async (value) => {
            this.plugin.settings.syncProfile = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync community plugin settings")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncPlugins).onChange(async (value) => {
          this.plugin.settings.syncPlugins = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

