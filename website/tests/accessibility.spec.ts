// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function expectAccessible(page: Page) {
	const results = await new AxeBuilder({ page }).analyze();
	expect(results.violations.map(({ id, nodes }) => ({
		id,
		nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
	}))).toEqual([]);
	expect(await page.evaluate(() =>
		document.documentElement.scrollWidth <= document.documentElement.clientWidth,
	)).toBe(true);
}

test('landing page and interactive example are accessible', async ({ page }) => {
	await page.goto('/scope/');
	await expect(page.locator('scope-flow [data-play]')).toBeEnabled();
	await expectAccessible(page);

	await page.locator('[data-step="2"]').click();
	await page.getByText('Explore the criteria graph', { exact: true }).click();
	await expectAccessible(page);

	await page.locator('[data-step="3"]').click();
	await page.getByText('Inspect per-criterion outcomes', { exact: true }).click();
	await expectAccessible(page);
});

for (const path of ['/', '/introduction/what-is-scope/', '/community/articles-and-talks/', '/reference/api/']) {
	test(`privacy links and landmarks on ${path}`, async ({ page }) => {
		const externalRequests: string[] = [];
		page.on('request', (request) => {
			if (new URL(request.url()).origin !== 'http://127.0.0.1:14321') {
				externalRequests.push(request.url());
			}
		});
		await page.goto(`/scope${path}`);
		const footer = page.getByRole('contentinfo');
		await expect(footer).toHaveCount(1);
		for (const [name, href] of [
			['Your Privacy Choices', 'https://aka.ms/yourcaliforniaprivacychoices'],
			['Consumer Health Privacy', 'https://go.microsoft.com/fwlink/?linkid=2259814'],
		]) {
			const link = footer.getByRole('link', { name, exact: false });
			await expect(link).toBeVisible();
			await expect(link).toHaveAttribute('href', href);
			await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
		}
		await expect(page.getByRole('main')).toHaveCount(1);
		await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
		await expect(footer.getByRole('link', { name: 'Your Privacy Choices' }).locator('svg'))
			.toHaveAttribute('aria-hidden', 'true');
		await expectAccessible(page);
		expect(externalRequests).toEqual([]);
	});
}

test('demo steps and disclosures work with the keyboard', async ({ page }) => {
	await page.goto('/scope/');
	const judge = page.locator('[data-step="2"]');
	await judge.focus();
	await page.keyboard.press('Enter');
	await expect(judge).toBeFocused();
	const explorer = page.locator('[data-criteria-explorer]');
	await explorer.locator('summary').focus();
	await page.keyboard.press('Enter');
	await expect(explorer).toHaveAttribute('open', '');
	await page.keyboard.press('Space');
	await expect(explorer).not.toHaveAttribute('open', '');
	await expect(page.locator('scope-flow')).toHaveAttribute('data-playing', 'false');
	await expect(page.locator('scope-showreel video')).not.toHaveAttribute('src');
});

test('skip link moves keyboard focus to the visible landing heading', async ({ page }) => {
	await page.goto('/scope/');
	await page.keyboard.press('Tab');
	const skipLink = page.getByRole('link', { name: 'Skip to content' });
	await expect(skipLink).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.locator('#_top')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('link', { name: 'Start with Scope' })).toBeFocused();
});
