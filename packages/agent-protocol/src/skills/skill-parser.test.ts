// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { parseSkillMd } from './skill-parser.js';

describe('parseSkillMd', () => {
  it('should parse valid SKILL.md with required fields', () => {
    const raw = `---
name: my-skill
description: A skill that does things
---

# My Skill

Instructions here.
`;
    const result = parseSkillMd(raw);

    expect(result.frontmatter.name).toBe('my-skill');
    expect(result.frontmatter.description).toBe('A skill that does things');
    expect(result.content).toBe('# My Skill\n\nInstructions here.');
    expect(result.raw).toBe(raw);
  });

  it('should parse all optional frontmatter fields', () => {
    const raw = `---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents.
license: Apache-2.0
compatibility: Requires poppler-utils
allowed-tools: Bash(pdftotext:*) Read
metadata:
  author: example-org
  version: "1.0"
---

Body content here.
`;
    const result = parseSkillMd(raw);

    expect(result.frontmatter.name).toBe('pdf-processing');
    expect(result.frontmatter.description).toContain('Extract text');
    expect(result.frontmatter.license).toBe('Apache-2.0');
    expect(result.frontmatter.compatibility).toBe('Requires poppler-utils');
    expect(result.frontmatter.allowedTools).toBe('Bash(pdftotext:*) Read');
    expect(result.frontmatter.metadata).toEqual({
      author: 'example-org',
      version: '1.0',
    });
  });

  it('should throw if name is missing', () => {
    const raw = `---
description: A skill without a name
---

Body.
`;
    expect(() => parseSkillMd(raw)).toThrow('missing required frontmatter field: name');
  });

  it('should throw if description is missing', () => {
    const raw = `---
name: my-skill
---

Body.
`;
    expect(() => parseSkillMd(raw)).toThrow('missing required frontmatter field: description');
  });

  it('should coerce metadata values to strings', () => {
    const raw = `---
name: my-skill
description: Test skill
metadata:
  count: 42
  active: true
---

Body.
`;
    const result = parseSkillMd(raw);
    expect(result.frontmatter.metadata).toEqual({
      count: '42',
      active: 'true',
    });
  });

  it('should handle SKILL.md with no optional fields', () => {
    const raw = `---
name: minimal-skill
description: Minimal skill with only required fields
---

Instructions.
`;
    const result = parseSkillMd(raw);

    expect(result.frontmatter.name).toBe('minimal-skill');
    expect(result.frontmatter.license).toBeUndefined();
    expect(result.frontmatter.compatibility).toBeUndefined();
    expect(result.frontmatter.allowedTools).toBeUndefined();
    expect(result.frontmatter.metadata).toBeUndefined();
  });

  it('should trim content whitespace', () => {
    const raw = `---
name: my-skill
description: Test
---

  Content with leading space.

`;
    const result = parseSkillMd(raw);
    expect(result.content).toBe('Content with leading space.');
  });
});
