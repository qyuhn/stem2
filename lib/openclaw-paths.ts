import path from 'path';
import os from 'os';

export const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
export const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
export const OPENCLAW_PIXEL_OFFICE_DIR = path.join(OPENCLAW_HOME, 'pixel-office');
export const OPENCLAW_AGENTS_DIR = path.join(OPENCLAW_HOME, 'agents');