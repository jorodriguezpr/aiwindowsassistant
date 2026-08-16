/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import SysTray, { MenuItem } from 'systray2';
import { config } from '../config';
import type { Logger } from '../logger';

export interface TrayCallbacks {
  onPauseToggle: () => boolean; // returns new paused state
  onTestMessage: () => void;
  onQuit: () => void;
}

const SEPARATOR = 'SEPARATOR';

/**
 * Windows system tray icon (systray2). Keeps the app visible and controllable
 * without a console window.
 */
export class TrayIcon {
  private systray: SysTray | null = null;
  private paused = false;
  private statusText = 'Starting…';
  private logger?: Logger;

  constructor(private callbacks: TrayCallbacks, logger?: Logger) {
    this.logger = logger;
  }

  private loadIconBase64(): string {
    const iconPath = path.join(config.assetsDir, 'icon.ico');
    if (!fs.existsSync(iconPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { generateIcon } = require(path.join(config.projectRoot, 'scripts', 'generate-icon.js'));
        generateIcon(iconPath);
      } catch (err) {
        this.logger?.warn({ err }, 'icon generation failed');
        return '';
      }
    }
    return fs.readFileSync(iconPath).toString('base64');
  }

  private buildMenu() {
    const items: MenuItem[] = [
      { title: `AiWindowsAssistant — ${this.paused ? '⏸ Paused' : '▶ Running'}`, tooltip: 'Status', checked: false, enabled: false },
      { title: this.statusText, tooltip: 'AI provider / model', checked: false, enabled: false },
      { title: SEPARATOR, tooltip: '', checked: false, enabled: true },
      { title: this.paused ? '▶ Resume bot' : '⏸ Pause bot', tooltip: 'Toggle Telegram message processing', checked: false, enabled: true },
      { title: '📩 Send test message', tooltip: 'Send a test Telegram message to the owner', checked: false, enabled: true },
      { title: '📂 Open logs folder', tooltip: config.logDir, checked: false, enabled: true },
      { title: '⚙ Open config (.env)', tooltip: 'Edit configuration', checked: false, enabled: true },
      { title: SEPARATOR, tooltip: '', checked: false, enabled: true },
      { title: '❌ Quit', tooltip: 'Stop AiWindowsAssistant', checked: false, enabled: true },
    ];
    return {
      icon: this.loadIconBase64(),
      title: '',
      tooltip: `AiWindowsAssistant — ${this.paused ? 'Paused' : 'Running'}`,
      items,
    };
  }

  async start(): Promise<void> {
    this.systray = new SysTray({ menu: this.buildMenu(), debug: false, copyDir: true });

    this.systray.onClick((action) => {
      const title = action.item.title;
      if (title.includes('Pause bot') || title.includes('Resume bot')) {
        this.setPaused(this.callbacks.onPauseToggle());
      } else if (title.includes('test message')) {
        this.callbacks.onTestMessage();
      } else if (title.includes('logs folder')) {
        exec(`explorer.exe "${config.logDir}"`);
      } else if (title.includes('config')) {
        exec(`notepad.exe "${path.join(config.projectRoot, '.env')}"`);
      } else if (title.includes('Quit')) {
        this.callbacks.onQuit();
      }
    });

    await this.systray.ready();
    this.logger?.info('tray icon started');
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    void this.refresh();
  }

  setStatus(text: string): void {
    this.statusText = text;
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.systray) return;
    try {
      await this.systray.sendAction({ type: 'update-menu', menu: this.buildMenu() });
    } catch (err) {
      this.logger?.warn({ err }, 'tray menu refresh failed');
    }
  }

  async kill(): Promise<void> {
    if (this.systray) {
      try {
        await this.systray.kill(false);
      } catch {
        /* already gone */
      }
      this.systray = null;
    }
  }
}
