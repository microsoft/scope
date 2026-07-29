#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// validate-skill.ts — Validate a skill from a GitHub repository
// =============================================================================
// Runs the full discovery → parse → validate flow against a live GitHub repo
// and reports detailed pass/fail output.
//
// Usage:
//   pnpm validate-skill <source> <skillName>
//
// Examples:
//   pnpm validate-skill apollographql/skills rust-best-practices
//   pnpm validate-skill Azure/documentdb-agent-kit connection
//   pnpm validate-skill Azure/documentdb-agent-kit documentdb-connection

import { SkillResolver } from '../packages/agent-protocol/src/skills/skill-resolver.js';
import { parseSkillMd } from '../packages/agent-protocol/src/skills/skill-parser.js';
import { validateSkillFrontmatter } from '../packages/agent-protocol/src/skills/skill-validator.js';

async function main() {
  const [source, skillName] = process.argv.slice(2);

  if (!source || !skillName) {
    console.error('Usage: pnpm validate-skill <source> <skillName>');
    console.error('  e.g. pnpm validate-skill apollographql/skills rust-best-practices');
    process.exit(1);
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const resolver = new SkillResolver({ githubToken });

  console.log(`\n🔍 Validating skill: ${source} / ${skillName}`);
  if (githubToken) {
    console.log('   (using GITHUB_TOKEN for authentication)');
  } else {
    console.log('   (no GITHUB_TOKEN — anonymous, rate-limited)');
  }
  console.log('');

  // Step 1: discover skill path
  process.stdout.write('1. Discovering skill path... ');
  const skillPath = await resolver.discoverSkillPath(source, skillName);
  if (!skillPath) {
    console.log('❌ FAIL');
    console.error(`\n   Skill "${skillName}" not found in repository "${source}".`);
    console.error('   Searched well-known directories: skills/, .agents/skills/, .github/skills/, .claude/skills/, .copilot/skills/, .roo/skills/, .cursor/skills/, <root>');
    process.exit(1);
  }
  console.log(`✅ found at "${skillPath}"`);

  // Step 2: fetch SKILL.md
  process.stdout.write('2. Fetching SKILL.md... ');
  const githubApiUrl = 'https://api.github.com';
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'scope-validate-skill',
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };

  const skillMdUrl = `${githubApiUrl}/repos/${source}/contents/${skillPath}/SKILL.md`;
  const res = await fetch(skillMdUrl, { headers });
  if (!res.ok) {
    console.log('❌ FAIL');
    console.error(`\n   Could not fetch SKILL.md: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (!data.content || data.encoding !== 'base64') {
    console.log('❌ FAIL');
    console.error('\n   Unexpected response format from GitHub Contents API');
    process.exit(1);
  }
  const rawContent = Buffer.from(data.content, 'base64').toString('utf-8');
  console.log('✅');

  // Step 3: parse SKILL.md
  process.stdout.write('3. Parsing SKILL.md frontmatter... ');
  let parsed;
  try {
    parsed = parseSkillMd(rawContent);
    console.log('✅');
    console.log(`   name:        ${parsed.frontmatter.name}`);
    console.log(`   description: ${parsed.frontmatter.description.slice(0, 80)}${parsed.frontmatter.description.length > 80 ? '…' : ''}`);
    if (parsed.frontmatter.license) console.log(`   license:     ${parsed.frontmatter.license}`);
  } catch (err) {
    console.log('❌ FAIL');
    console.error(`\n   Parse error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Step 4: validate frontmatter (pass dirName = the actual directory name)
  const dirName = skillPath.split('/').pop()!;
  process.stdout.write(`4. Validating frontmatter (dir="${dirName}")... `);
  const validation = validateSkillFrontmatter(parsed.frontmatter, dirName);
  if (!validation.valid) {
    console.log('❌ FAIL');
    for (const err of validation.errors) {
      console.error(`   [${err.field}] ${err.message}`);
    }
    process.exit(1);
  }
  if (validation.warnings.length > 0) {
    console.log('⚠️  WARNINGS');
    for (const warn of validation.warnings) {
      console.warn(`   [${warn.field}] ${warn.message}`);
    }
  } else {
    console.log('✅');
  }

  if (validation.warnings.length > 0) {
    console.log('\n⚠️  Skill is valid with warnings.\n');
  } else {
    console.log('\n✅ Skill is valid!\n');
  }
}

main().catch((err) => {
  console.error('\n💥 Unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
