import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CashClaw skills directory (shipped with the package)
const CASHCLAW_SKILLS_DIR = path.resolve(__dirname, '../../skills');

// Possible OpenClaw workspace locations
const OPENCLAW_PATHS = [
  path.join(os.homedir(), '.openclaw', 'workspace', 'skills'),
  path.join(os.homedir(), 'clawd', 'skills'),
  path.join(os.homedir(), '.clawd', 'skills'),
  path.join(os.homedir(), 'openclaw', 'skills'),
];

/**
 * Detect if OpenClaw is installed by checking known paths.
 * @returns {object} { found: boolean, path: string|null, paths_checked: string[] }
 */
export async function detectOpenClaw() {
  for (const skillsPath of OPENCLAW_PATHS) {
    try {
      const exists = await fs.pathExists(skillsPath);
      if (exists) {
        return {
          found: true,
          path: path.dirname(skillsPath), // workspace root
          skills_dir: skillsPath,
          paths_checked: OPENCLAW_PATHS,
        };
      }
    } catch {
      continue;
    }
  }

  return {
    found: false,
    path: null,
    skills_dir: null,
    paths_checked: OPENCLAW_PATHS,
  };
}

/**
 * Get the OpenClaw skills directory.
 * Uses auto-detection or config override.
 * @param {string} configOverride - Optional explicit path from config
 * @returns {string|null} Path to skills directory
 */
export async function getSkillsDir(configOverride = null) {
  if (configOverride && await fs.pathExists(configOverride)) {
    return configOverride;
  }

  const detection = await detectOpenClaw();
  return detection.skills_dir;
}

/**
 * List available CashClaw skills that can be installed.
 * Reads from the cashclaw/skills/ directory shipped with the package.
 * @returns {Array} List of skill objects
 */
export async function listAvailableSkills() {
  try {
    const exists = await fs.pathExists(CASHCLAW_SKILLS_DIR);
    if (!exists) {
      return [];
    }

    const entries = await fs.readdir(CASHCLAW_SKILLS_DIR, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(CASHCLAW_SKILLS_DIR, entry.name);
        const skillMd = path.join(skillPath, 'SKILL.md');
        const hasSkillMd = await fs.pathExists(skillMd);

        skills.push({
          name: entry.name,
          path: skillPath,
          has_skill_md: hasSkillMd,
        });
      }
    }

    return skills;
  } catch (err) {
    console.error(`Error listing skills: ${err.message}`);
    return [];
  }
}

/**
 * List skills currently installed in the OpenClaw workspace.
 * @param {string} configOverride - Optional explicit skills dir path
 * @returns {Array} List of installed skill names
 */
export async function listInstalledSkills(configOverride = null) {
  const skillsDir = await getSkillsDir(configOverride);
  if (!skillsDir) {
    return [];
  }

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith('cashclaw-'))
      .map((e) => e.name);
  } catch (err) {
    return [];
  }
}

/**
 * Install CashClaw skills into the OpenClaw workspace.
 * Copies skill directories from cashclaw/skills/ to the OpenClaw skills folder.
 * @param {string[]} skillNames - Array of skill folder names (e.g. ['cashclaw-seo-auditor'])
 * @param {string} configOverride - Optional explicit skills dir path
 * @returns {object} Installation results
 */
export async function installSkills(skillNames, configOverride = null) {
  const targetDir = await getSkillsDir(configOverride);

  if (!targetDir) {
    return {
      success: false,
      installed: [],
      failed: skillNames.map((n) => ({ name: n, error: 'OpenClaw workspace not found' })),
      message:
        'OpenClaw workspace not found. Please install OpenClaw first or set the skills path in config.',
    };
  }

  await fs.ensureDir(targetDir);

  const installed = [];
  const failed = [];

  for (const skillName of skillNames) {
    const sourcePath = path.join(CASHCLAW_SKILLS_DIR, skillName);
    const destPath = path.join(targetDir, skillName);

    try {
      const sourceExists = await fs.pathExists(sourcePath);
      if (!sourceExists) {
        failed.push({ name: skillName, error: 'Skill not found in CashClaw package' });
        continue;
      }

      // Copy the entire skill directory
      await fs.copy(sourcePath, destPath, { overwrite: true });
      installed.push(skillName);
    } catch (err) {
      failed.push({ name: skillName, error: err.message });
    }
  }

  return {
    success: failed.length === 0,
    installed,
    failed,
    target_dir: targetDir,
    message:
      installed.length > 0
        ? `Installed ${installed.length} skill(s) to ${targetDir}`
        : 'No skills were installed',
  };
}

/**
 * Uninstall CashClaw skills from OpenClaw workspace.
 * @param {string[]} skillNames - Array of skill names to remove
 * @param {string} configOverride - Optional explicit skills dir path
 */
export async function uninstallSkills(skillNames, configOverride = null) {
  const targetDir = await getSkillsDir(configOverride);
  if (!targetDir) {
    return { success: false, removed: [], message: 'OpenClaw workspace not found' };
  }

  const removed = [];
  for (const skillName of skillNames) {
    const destPath = path.join(targetDir, skillName);
    try {
      const exists = await fs.pathExists(destPath);
      if (exists) {
        await fs.remove(destPath);
        removed.push(skillName);
      }
    } catch {
      continue;
    }
  }

  return {
    success: true,
    removed,
    message: `Removed ${removed.length} skill(s)`,
  };
}
