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
	const kubernetesSection = page.locator('.scope-kubernetes');
	await expect(kubernetesSection).toHaveCSS('background-color', 'rgb(247, 250, 255)');
	await expect(kubernetesSection.locator('.scope-kubernetes-description'))
		.toContainText('queue-driven scaling with KEDA');
	const kubernetesLogo = kubernetesSection.getByRole('img', { name: 'Kubernetes', exact: true });
	await expect(kubernetesLogo).toBeVisible();
	await expect(kubernetesLogo).toHaveAttribute('src', '/scope/kubernetes-stacked-color.svg');
	const scalingFeature = kubernetesSection.getByRole('listitem').first();
	const scalingDocsLink = scalingFeature.getByRole('link', { name: 'Queue-driven scaling', exact: true });
	await expect(scalingDocsLink).toHaveAttribute('href', '/scope/self-hosting/scaling/');
	const kedaLink = scalingFeature.getByRole('link', { name: 'KEDA (opens in a new tab)', exact: true });
	await expect(kedaLink).toBeVisible();
	await expect(kedaLink).toHaveAttribute('href', 'https://keda.sh/');
	await expect(kedaLink).toHaveAttribute('target', '_blank');
	await expect(kedaLink).toHaveAttribute('rel', 'noopener noreferrer');
	await expect(kedaLink).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	const kedaLogo = kedaLink.getByRole('img', { name: 'KEDA', exact: true });
	await expect(kedaLogo).toBeVisible();
	await expect(kedaLogo).toHaveAttribute('src', '/scope/keda-horizontal-color.svg');
	await expect(page.locator('scope-flow [data-play]')).toBeEnabled();
	await expectAccessible(page);

	await page.locator('[data-step="2"]').click();
	await page.getByText('Explore the criteria graph', { exact: true }).click();
	await expectAccessible(page);

	await page.locator('[data-step="3"]').click();
	await page.getByText('Inspect per-criterion outcomes', { exact: true }).click();
	await expectAccessible(page);

	await scalingDocsLink.click();
	await expect(page).toHaveURL(/\/scope\/self-hosting\/scaling\/$/);
	await expect(page.getByRole('heading', { name: 'Autoscaling with KEDA', level: 1, exact: true }))
		.toBeVisible();
});

test('infrastructure feature tiles align their graphics and copy', async ({ page }) => {
	await page.goto('/scope/');
	const features = page.locator('.scope-kubernetes-features');
	await expect(features.locator('.scope-feature-graphic')).toHaveCount(3);
	await expect(features.locator('.scope-feature-graphic > svg[aria-hidden="true"]')).toHaveCount(2);
	await expect(features.locator(':scope > li > span')).toHaveText([
		'KEDA scales workers with demand.',
		'Coding agents run in containers.',
		'Flux keeps deployments in sync.',
	]);

	const layout = await features.evaluate((grid) => {
		const topSpread = (selector: string) => {
			const positions = Array.from(grid.children, (item) => {
				const element = item.querySelector(selector);
				if (!element) throw new Error(`Feature tile is missing ${selector}`);
				return element.getBoundingClientRect().top;
			});
			return Math.max(...positions) - Math.min(...positions);
		};
		return {
			columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
			graphics: topSpread('.scope-feature-graphic'),
			headings: topSpread('strong'),
			descriptions: topSpread(':scope > span'),
			graphicCenterOffsets: Array.from(grid.querySelectorAll('.scope-feature-graphic'), (graphic) => {
				const visual = graphic.querySelector('img, svg');
				if (!visual) throw new Error('Feature tile is missing its graphic');
				const frame = graphic.getBoundingClientRect();
				const image = visual.getBoundingClientRect();
				return Math.abs(frame.top + frame.height / 2 - image.top - image.height / 2);
			}),
		};
	});
	for (const offset of layout.graphicCenterOffsets) {
		expect(offset).toBeLessThanOrEqual(1);
	}
	if (layout.columns === 3) {
		expect(layout.graphics).toBeLessThanOrEqual(1);
		expect(layout.headings).toBeLessThanOrEqual(1);
		expect(layout.descriptions).toBeLessThanOrEqual(1);
	}
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
		const deploymentLink = footer.getByRole('list', { name: /^learn$/i })
			.getByRole('link', { name: 'Kubernetes deployment', exact: true });
		await expect(deploymentLink).toBeVisible();
		await expect(deploymentLink).toHaveAttribute('href', '/scope/self-hosting/deploy-helm/');
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
