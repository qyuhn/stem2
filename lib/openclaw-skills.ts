import fs from 'fs';
import path from 'path';
import { OPENCLAW_HOME } from './openclaw-paths';

interface Skill {
  id: string;
  name: string;
  source: string;
}

const SKILLS_DIR = path.join(OPENCLAW_HOME, 'skills');

export function listOpenclawSkills(): Skill[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  
  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      id: d.name,
      name: d.name,
      source: 'custom'
    }));
  
  return dirs;
}

export function getOpenclawSkillContent(source: string, id: string): string {
  const skillDir = path.join(OPENCLAW_HOME, 'skills', id);
  const readmePath = path.join(skillDir, 'README.md');
  
  if (!fs.existsSync(readmePath)) return '';
  
  return fs.readFileSync(readmePath, 'utf-8');
}