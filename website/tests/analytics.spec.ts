// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, test, type Page } from '@playwright/test';

const PUBLISHED_DATA_URLS = new Set([
	'https://raw.githubusercontent.com/microsoft/scope/website-data/issues.jsonl',
	'https://raw.githubusercontent.com/microsoft/scope/website-data/contributors.jsonl',
]);

interface AnalyticsTestState {
	granted: boolean;
	consentRequired: boolean;
	configurations: unknown[];
	extensions: unknown[];
	paused: number;
	unloaded: number;
	managed: number;
	appliedThemes: string[];
	initializer?: () => boolean;
	changeConsent?: () => void;
}

declare global {
	interface Window {
		scopeAnalyticsTest: AnalyticsTestState;
	}
}

function consentStub() {
	const state = window.scopeAnalyticsTest;
	window.WcpConsent = {
		consentCategories: { Analytics: 'Analytics' },
		init(_language, placeholder, callback, onConsentChanged) {
			placeholder.style.cssText = 'background:white;color:black';
			const accept = document.createElement('button');
			accept.textContent = 'Accept analytics';
			accept.onclick = () => {
				state.granted = true;
				onConsentChanged();
			};
			const reject = document.createElement('button');
			reject.textContent = 'Reject analytics';
			reject.onclick = () => {
				state.granted = false;
				onConsentChanged();
			};
			placeholder.append(accept, reject);
			state.changeConsent = onConsentChanged;
			callback(undefined, {
				isConsentRequired: state.consentRequired,
				getConsentFor: () => state.granted,
				manageConsent: () => { state.managed++; },
				applyTheme: (theme) => { state.appliedThemes.push(theme); },
			});
		},
	};
}

function analyticsStub() {
	const state = window.scopeAnalyticsTest;
	window.oneDS = {
		ApplicationInsights: class {
			initialize(configuration: unknown, extensions: unknown[]) {
				state.configurations.push(configuration);
				state.extensions.push(extensions);
			}
			addTelemetryInitializer(initializer: () => boolean) {
				state.initializer = initializer;
			}
			getTransmissionControls() {
				return [[{ pause: () => { state.paused++; } }]];
			}
			unload() {
				if (state.paused <= state.unloaded) throw new Error('SDK unloaded without pausing');
				state.unloaded++;
			}
		},
	};
}

async function mockPublishedSite(page: Page, options: {
	granted?: boolean;
	consentRequired?: boolean;
	globalPrivacyControl?: boolean;
	doNotTrack?: string;
} = {}) {
	await page.addInitScript((options) => {
		window.scopeAnalyticsTest = {
			granted: options.granted ?? false,
			consentRequired: options.consentRequired ?? true,
			configurations: [],
			extensions: [],
			paused: 0,
			unloaded: 0,
			managed: 0,
			appliedThemes: [],
		};
		Object.defineProperty(navigator, 'globalPrivacyControl', { value: options.globalPrivacyControl ?? false });
		Object.defineProperty(navigator, 'doNotTrack', { value: options.doNotTrack ?? null });
	}, options);
	await page.route('https://microsoft.github.io/**', async (route) => {
		const url = new URL(route.request().url());
		const response = await page.request.get(`http://127.0.0.1:14321${url.pathname}${url.search}`);
		await route.fulfill({ response });
	});
	await page.route('https://wcpstatic.microsoft.com/**', async (route) => {
		await route.fulfill({ contentType: 'text/javascript', body: `(${consentStub.toString()})();` });
	});
	await page.route('https://js.monitor.azure.com/**', async (route) => {
		await route.fulfill({ contentType: 'text/javascript', body: `(${analyticsStub.toString()})();` });
	});
	await page.route('https://*.events.data.microsoft.com/**', (route) => route.abort());
}

test('analytics waits for consent and uses the Scope configuration', async ({ page }) => {
	await mockPublishedSite(page);
	const sdkRequests: string[] = [];
	page.on('request', (request) => {
		if (request.url().startsWith('https://js.monitor.azure.com/')) sdkRequests.push(request.url());
	});
	await page.goto('https://microsoft.github.io/scope/?private-query=not-for-analytics#private-fragment');
	await expect(page.getByRole('button', { name: 'Manage cookies' })).toBeVisible();
	expect(await page.evaluate(() => document.body.firstElementChild?.textContent?.trim())).toBe('Skip to content');
	expect(sdkRequests).toEqual([]);
	await page.getByRole('button', { name: 'Reject analytics' }).click();
	expect(sdkRequests).toEqual([]);

	await page.getByRole('button', { name: 'Accept analytics' }).click();
	await expect.poll(() => page.evaluate(() => window.scopeAnalyticsTest.configurations.length)).toBe(1);
	expect(sdkRequests).toEqual(['https://js.monitor.azure.com/scripts/c/ms.analytics-web-3.min.js']);
	expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations[0])).toEqual({
		instrumentationKey: 'd73f4c6d7bfd4f54ab769e2baaf3156b-3241346c-4fe3-4bd7-a8b6-7ca73da60140-7462',
		disableCookiesUsage: true,
		channelConfiguration: { eventsLimitInMem: 50 },
		propertyConfiguration: { env: 'PROD', userConsented: true },
		webAnalyticsConfiguration: {
			urlCollectQuery: false,
			urlCollectHash: false,
			autoCapture: {
				scroll: true, pageView: true, onLoad: true, onUnload: true,
				click: true, resize: true, jsError: true,
			},
		},
	});
	expect(await page.evaluate(() => window.scopeAnalyticsTest.extensions)).toEqual([[]]);
});

test('stored consent initializes once and can be withdrawn and granted again', async ({ page }) => {
	await mockPublishedSite(page, { granted: true });
	await page.goto('https://microsoft.github.io/scope/introduction/what-is-scope/');
	await expect.poll(() => page.evaluate(() => window.scopeAnalyticsTest.configurations.length)).toBe(1);
	await page.getByRole('button', { name: 'Accept analytics' }).click();
	expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations.length)).toBe(1);
	await page.getByRole('button', { name: 'Manage cookies' }).click();
	expect(await page.evaluate(() => window.scopeAnalyticsTest.managed)).toBe(1);
	expect(await page.evaluate(() => window.scopeAnalyticsTest.initializer?.())).toBe(true);

	await page.getByRole('button', { name: 'Reject analytics' }).click();
	expect(await page.evaluate(() => window.scopeAnalyticsTest.unloaded)).toBe(1);
	expect(await page.evaluate(() => window.scopeAnalyticsTest.initializer?.())).toBe(false);
	await page.getByRole('button', { name: 'Accept analytics' }).click();
	await expect.poll(() => page.evaluate(() => window.scopeAnalyticsTest.configurations.length)).toBe(2);
	expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations)).toMatchObject([
		{ propertyConfiguration: { userConsented: true } },
		{ propertyConfiguration: { userConsented: true } },
	]);

	await page.goto('https://microsoft.github.io/scope/getting-started/access/');
	await expect.poll(() => page.evaluate(() => window.scopeAnalyticsTest.configurations.length)).toBe(1);
	expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations[0])).toMatchObject({
		propertyConfiguration: { userConsented: true },
	});
});

test('consent UI follows Starlight theme changes', async ({ page }) => {
	await mockPublishedSite(page);
	await page.goto('https://microsoft.github.io/scope/');
	await expect.poll(() => page.evaluate(() => Boolean(window.scopeAnalyticsTest.changeConsent))).toBe(true);
	const initialTheme = await page.evaluate(
		() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
	);
	const nextTheme = initialTheme === 'light' ? 'dark' : 'light';

	await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, initialTheme);
	await expect.poll(() => page.evaluate(() => window.scopeAnalyticsTest.appliedThemes)).toEqual([]);
	await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, nextTheme);
	await expect.poll(() => page.evaluate(() => window.scopeAnalyticsTest.appliedThemes)).toEqual([nextTheme]);
	await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, initialTheme);
	await expect.poll(() => page.evaluate(() => window.scopeAnalyticsTest.appliedThemes)).toEqual([nextTheme, initialTheme]);
});

for (const path of ['/', '/introduction/what-is-scope/', '/community/articles-and-talks/', '/reference/api/']) {
	test(`cookie banner stays above the header on ${path}`, async ({ page }) => {
		await mockPublishedSite(page);
		await page.goto(`https://microsoft.github.io/scope${path}`);
		const banner = page.locator('#scope-cookie-banner');
		await expect(banner.getByRole('button', { name: 'Accept analytics' })).toBeVisible();
		expect(await page.evaluate(() => document.body.firstElementChild?.textContent?.trim())).toBe('Skip to content');
		await page.keyboard.press('Tab');
		await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

		const expectBannerLayout = async () => {
			await expect.poll(() => page.evaluate(() => {
				const banner = document.querySelector('#scope-cookie-banner')?.getBoundingClientRect();
				const header = document.querySelector('header.header')?.getBoundingClientRect();
				const main = document.querySelector('main')?.getBoundingClientRect();
				return Boolean(banner && header && main && banner.height > 0 &&
					Math.abs(banner.top) < 1 && Math.abs(header.top - banner.bottom) < 1 &&
					main.top >= header.bottom - 1 &&
					document.documentElement.scrollWidth <= document.documentElement.clientWidth);
			})).toBe(true);
			const menu = page.locator('starlight-menu-button button');
			if (await menu.isVisible()) {
				const menuBox = await menu.boundingBox();
				const headerBox = await page.locator('header.header').boundingBox();
				expect(menuBox && headerBox && menuBox.y >= headerBox.y &&
					menuBox.y + menuBox.height <= headerBox.y + headerBox.height).toBe(true);
			}
		};
		await expectBannerLayout();
		await banner.evaluate((element) => {
			const message = document.createElement('p');
			message.textContent = 'Review your optional cookie choices. '.repeat(10);
			element.prepend(message);
		});
		await expectBannerLayout();

		await banner.evaluate((element) => element.replaceChildren());
		await expect.poll(() => page.locator('header.header').evaluate(
			(element) => element.getBoundingClientRect().top,
		)).toBe(0);
	});
}

for (const options of [
	{ globalPrivacyControl: true },
	{ doNotTrack: '1' },
	{ consentRequired: false },
]) {
	test(`analytics remains disabled for ${JSON.stringify(options)}`, async ({ page }) => {
		await mockPublishedSite(page, { granted: true, ...options });
		const sdkRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().startsWith('https://js.monitor.azure.com/')) sdkRequests.push(request.url());
		});
		await page.goto('https://microsoft.github.io/scope/');
		await expect(page.getByRole('button', { name: 'Manage cookies' })).toBeVisible();
		await page.getByRole('button', { name: 'Accept analytics' }).click();
		expect(sdkRequests).toEqual([]);
		expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations)).toEqual([]);
	});
}

test('withdrawal while the SDK loads prevents initialization', async ({ page }) => {
	await mockPublishedSite(page);
	let releaseSdk: (() => void) | undefined;
	const sdkReady = new Promise<void>((resolve) => { releaseSdk = resolve; });
	await page.route('https://js.monitor.azure.com/**', async (route) => {
		await sdkReady;
		await route.fulfill({ contentType: 'text/javascript', body: `(${analyticsStub.toString()})();` });
	});
	await page.goto('https://microsoft.github.io/scope/');
	const request = page.waitForRequest('https://js.monitor.azure.com/scripts/c/ms.analytics-web-3.min.js');
	await page.getByRole('button', { name: 'Accept analytics' }).click();
	await request;
	await page.getByRole('button', { name: 'Reject analytics' }).click();
	releaseSdk?.();
	await page.waitForFunction(() => window.oneDS !== undefined);
	expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations)).toEqual([]);
	await page.getByRole('button', { name: 'Accept analytics' }).click();
	await expect.poll(() => page.evaluate(() => window.scopeAnalyticsTest.configurations.length)).toBe(1);
	expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations[0])).toMatchObject({
		propertyConfiguration: { userConsented: true },
	});
});

test('blocked consent scripts fail closed without breaking documentation', async ({ page }) => {
	await mockPublishedSite(page, { granted: true });
	await page.route('https://wcpstatic.microsoft.com/**', (route) => route.abort());
	const error = page.waitForEvent('console', (message) => message.type() === 'error' &&
		message.text().includes('analytics remains disabled'));
	await page.goto('https://microsoft.github.io/scope/');
	await error;
	await expect(page.getByRole('main')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Manage cookies' })).toBeHidden();
	expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations)).toEqual([]);
});

test('blocked analytics scripts leave consent management and documentation usable', async ({ page }) => {
	await mockPublishedSite(page, { granted: true });
	await page.route('https://js.monitor.azure.com/**', (route) => route.abort());
	const error = page.waitForEvent('console', (message) => message.type() === 'error' &&
		message.text().includes('could not update its consent state'));
	await page.goto('https://microsoft.github.io/scope/');
	await error;
	await expect(page.getByRole('main')).toBeVisible();
	await page.getByRole('button', { name: 'Manage cookies' }).click();
	expect(await page.evaluate(() => window.scopeAnalyticsTest.managed)).toBe(1);
	expect(await page.evaluate(() => window.scopeAnalyticsTest.configurations)).toEqual([]);
});

test('local production previews make no consent or analytics requests', async ({ page }) => {
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		if (
			new URL(request.url()).origin !== 'http://127.0.0.1:14321' &&
			!PUBLISHED_DATA_URLS.has(request.url())
		) {
			externalRequests.push(request.url());
		}
	});
	await page.goto('/scope/');
	await expect(page.getByRole('main')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Manage cookies' })).toBeHidden();
	expect(externalRequests).toEqual([]);
});
