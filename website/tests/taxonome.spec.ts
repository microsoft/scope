// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loadTaxonomeCatalog } from '../src/lib/taxonome-catalog.mjs';

const catalog = await loadTaxonomeCatalog();

test('canonical Taxonome sources are generated, readable and keyboard accessible', async ({ page }) => {
	const requests: string[] = [];
	page.on('request', request => {
		if (new URL(request.url()).origin !== 'http://127.0.0.1:14321') requests.push(request.url());
	});
	await page.goto('/scope/reference/taxonome-elements/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ax taxonomy and elements');
	await expect(page.locator('[data-element-id]')).toHaveCount(catalog.elements.length);
	const manifest = page.locator('#taxonomy-source');
	await manifest.locator('summary').focus();
	await page.keyboard.press('Enter');
	await expect(manifest).toHaveAttribute('open', '');
	await expect(manifest.locator('code')).toHaveText(catalog.source.trim());
	for (const element of catalog.elements) {
		const section = page.locator(`[data-element-id="${element.id}"]`);
		await expect(section.getByRole('heading', { level: 2 })).toHaveText(element.label);
		const disclosure = section.locator('details');
		await disclosure.locator('summary').click();
		await expect(disclosure.locator('code')).toHaveText(element.source.trim());
		await expect(disclosure.locator('summary')).toContainText(element.file);
		await disclosure.locator('summary').click();
	}
	await expect(page.locator('main a[href="/scope/guides/taxonome/"]').first()).toBeVisible();
	const results = await new AxeBuilder({ page }).analyze();
	expect(results.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
	expect(requests).toEqual([]);
});

test('contract reference source panels and guide remain accessible', async ({ page }) => {
	for (const route of [
		'guides/taxonome',
		'reference/taxonome-cli',
		'reference/taxonome-taxonomy',
		'reference/taxonome-handlers',
	]) {
		await page.goto(`/scope/${route}/`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
		const panel = page.locator('.canonical-source').first();
		if (await panel.count()) {
			await panel.locator('summary').focus();
			await page.keyboard.press('Enter');
			await expect(panel).toHaveAttribute('open', '');
			await expect(panel.locator('code')).not.toBeEmpty();
		}
		const results = await new AxeBuilder({ page }).analyze();
		expect(results.violations.map(item => ({ route, id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
	}
});

test('one workflow guide links all four precise Taxonome references', async ({ page }) => {
	await page.goto('/scope/guides/taxonome/');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	for (const slug of ['cli', 'taxonomy', 'elements', 'handlers']) {
		const link = page.locator(`main a[href="/scope/reference/taxonome-${slug}/"]`).first();
		await expect(link).toBeVisible();
	}
	await expect(page.locator('main')).toContainText('Create your own');
});
