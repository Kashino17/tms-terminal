import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../utils/logger';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TestResult {
  date: string;
  passed: boolean;
  output: string;
  error?: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  scriptPath: string;
  dependencies: string[];
  status: 'draft' | 'testing' | 'approved' | 'failed';
  testResults: TestResult[];
  createdAt: string;
  updatedAt: string;
}

// ── Paths ───────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.tms-terminal');
const SKILLS_DB_FILE = path.join(CONFIG_DIR, 'skills-db.json');
const SKILLS_DIR = path.join(CONFIG_DIR, 'skills');

// ── Registry Functions ──────────────────────────────────────────────────────

export function ensureSkillDirs(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

export function loadSkills(): SkillDefinition[] {
  try {
    if (fs.existsSync(SKILLS_DB_FILE)) {
      return JSON.parse(fs.readFileSync(SKILLS_DB_FILE, 'utf-8'));
    }
  } catch {
    logger.warn('Skills: failed to load skills-db.json, starting fresh');
  }
  return [];
}

export function saveSkills(skills: SkillDefinition[]): void {
  ensureSkillDirs();
  fs.writeFileSync(SKILLS_DB_FILE, JSON.stringify(skills, null, 2));
}

export function findSkillById(id: string): SkillDefinition | undefined {
  return loadSkills().find(s => s.id === id);
}

export function findSkillByName(query: string): SkillDefinition | undefined {
  const skills = loadSkills();
  const q = query.toLowerCase();
  return skills.find(s =>
    s.name.toLowerCase().includes(q) ||
    s.id.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q)
  );
}

export function getApprovedSkills(): SkillDefinition[] {
  return loadSkills().filter(s => s.status === 'approved');
}

export function getAllSkills(): SkillDefinition[] {
  return loadSkills();
}

export function saveSkill(skill: SkillDefinition): void {
  const skills = loadSkills();
  const idx = skills.findIndex(s => s.id === skill.id);
  if (idx >= 0) {
    skills[idx] = skill;
  } else {
    skills.push(skill);
  }
  saveSkills(skills);
}

export function updateSkillStatus(
  id: string,
  status: SkillDefinition['status'],
  testResult?: TestResult,
): SkillDefinition | null {
  const skills = loadSkills();
  const skill = skills.find(s => s.id === id);
  if (!skill) return null;

  // CRITICAL RULE: Never mark as 'approved' if latest test failed
  if (status === 'approved' && testResult && !testResult.passed) {
    logger.warn(`Skills: BLOCKED — cannot approve "${skill.name}" with failed test`);
    skill.status = 'failed';
  } else {
    skill.status = status;
  }

  if (testResult) {
    skill.testResults.push(testResult);
  }
  skill.updatedAt = new Date().toISOString();
  saveSkills(skills);
  return skill;
}

export function createSkillId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

export function getSkillScriptPath(id: string, ext: string = '.sh'): string {
  ensureSkillDirs();
  return path.join(SKILLS_DIR, `${id}${ext}`);
}

export function writeSkillScript(id: string, code: string, ext: string = '.sh'): string {
  const scriptPath = getSkillScriptPath(id, ext);
  fs.writeFileSync(scriptPath, code, { mode: 0o755 });
  return scriptPath;
}

export function deleteSkill(id: string): boolean {
  const skills = loadSkills();
  const idx = skills.findIndex(s => s.id === id);
  if (idx < 0) return false;

  const skill = skills[idx];

  // Remove script file
  if (skill.scriptPath && fs.existsSync(skill.scriptPath)) {
    try { fs.unlinkSync(skill.scriptPath); } catch {}
  }

  skills.splice(idx, 1);
  saveSkills(skills);
  return true;
}

/** Build a summary of all skills for inclusion in AI context. */
export function buildSkillsSummary(): string {
  const skills = loadSkills();
  if (skills.length === 0) return '';

  const lines = skills.map(s => {
    const lastTest = s.testResults.length > 0 ? s.testResults[s.testResults.length - 1] : null;
    const statusIcon = s.status === 'approved' ? '+' : s.status === 'failed' ? '!' : '~';
    let line = `[${statusIcon}] ${s.name} (${s.status}) — ${s.description}`;
    if (s.status === 'failed' && lastTest?.error) {
      line += ` — FEHLER: ${lastTest.error.slice(0, 100)}`;
    }
    return line;
  });

  return `### Deine Skills (${skills.length})\n${lines.join('\n')}`;
}
