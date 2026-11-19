// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

interface SiteConsent {
	isConsentRequired: boolean;
	getConsentFor(category: string): boolean;
	manageConsent(): void;
	applyTheme(theme: 'light' | 'dark'): void;
}

interface WcpConsent {
	consentCategories: { Analytics: string };
	init(
		language: string,
		placeholder: HTMLElement,
		callback: (error: Error | undefined, consent?: SiteConsent) => void,
		onConsentChanged: () => void,
		theme: 'light' | 'dark',
	): void;
}

interface Analytics {
	initialize(config: typeof configuration, extensions: unknown[]): void;
	addTelemetryInitializer(initializer: () => boolean): void;
	getTransmissionControls(): { pause(): void }[][];
	unload(isAsync: boolean): void;
}

declare global {
	interface Window {
		WcpConsent?: WcpConsent;
		oneDS?: { ApplicationInsights: new () => Analytics };
	}
}

const wcpScript = 'https://wcpstatic.microsoft.com/mscc/lib/v2/wcp-consent.js';
const analyticsScript = 'https://js.monitor.azure.com/scripts/c/ms.analytics-web-3.min.js';
const configuration = {
	// This is a public browser-ingestion identifier, not an authentication credential.
	instrumentationKey: 'd73f4c6d7bfd4f54ab769e2baaf3156b-3241346c-4fe3-4bd7-a8b6-7ca73da60140-7462',
	disableCookiesUsage: true,
	channelConfiguration: { eventsLimitInMem: 50 },
	propertyConfiguration: { env: 'PROD', userConsented: false },
	webAnalyticsConfiguration: {
		urlCollectQuery: false,
		urlCollectHash: false,
		autoCapture: {
			scroll: true,
			pageView: true,
			onLoad: true,
			onUnload: true,
			click: true,
			resize: true,
			jsError: true,
		},
	},
};

function loadScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		const timeout = window.setTimeout(() => fail(), 10000);
		function fail() {
			window.clearTimeout(timeout);
			script.remove();
			reject(new Error(`Failed to load ${src}`));
		}
		script.async = true;
		script.src = src;
		script.addEventListener('load', () => {
			window.clearTimeout(timeout);
			resolve();
		}, { once: true });
		script.addEventListener('error', fail, { once: true });
		document.head.append(script);
	});
}

async function initializeConsent(allowAnalytics: boolean): Promise<void> {
	const manageCookies = document.querySelector<HTMLButtonElement>('[data-manage-cookies]');
	if (!manageCookies) throw new Error('Missing Scope cookie-management control');
	const skipLink = document.querySelector<HTMLAnchorElement>('body > a[href="#_top"]');
	if (!skipLink) throw new Error('Missing Scope skip link');

	const banner = document.createElement('div');
	banner.id = 'scope-cookie-banner';
	skipLink.after(banner);
	new ResizeObserver((entries) => {
		for (const { contentRect } of entries) {
			document.documentElement.style.setProperty('--scope-cookie-banner-height', `${contentRect.height}px`);
		}
	}).observe(banner);
	await loadScript(wcpScript);
	const wcp = window.WcpConsent;
	if (!wcp) throw new Error('Microsoft WCP consent API is unavailable');

	let siteConsent: SiteConsent | undefined;
	let analytics: Analytics | undefined;
	let sdkLoading: Promise<void> | undefined;
	const privacyNavigator: Navigator & { globalPrivacyControl?: boolean } = navigator;
	const hasAnalyticsConsent = () =>
		allowAnalytics &&
		siteConsent?.isConsentRequired === true &&
		siteConsent.getConsentFor(wcp.consentCategories.Analytics) === true &&
		privacyNavigator.globalPrivacyControl !== true &&
		privacyNavigator.doNotTrack !== '1';

	async function updateAnalytics(): Promise<void> {
		if (!hasAnalyticsConsent()) {
			const previous = analytics;
			analytics = undefined;
			if (previous) {
				// Pause before unloading so withdrawing consent does not flush queued events.
				for (const channels of previous.getTransmissionControls()) {
					for (const channel of channels) channel.pause();
				}
				previous.unload(false);
			}
			return;
		}
		if (analytics) return;
		if (!window.oneDS) {
			sdkLoading ??= loadScript(analyticsScript);
			try {
				await sdkLoading;
			} catch (error) {
				sdkLoading = undefined;
				throw error;
			}
		}
		// Consent can change while the CDN script is loading.
		if (!hasAnalyticsConsent() || analytics) return;
		if (!window.oneDS) throw new Error('Microsoft 1DS analytics API is unavailable');
		const current = new window.oneDS.ApplicationInsights();
		current.addTelemetryInitializer(() => current === analytics && hasAnalyticsConsent());
		analytics = current;
		try {
			// Delaying initialization until opt-in does not set the SDK's consent metadata.
			current.initialize({
				...configuration,
				propertyConfiguration: {
					...configuration.propertyConfiguration,
					userConsented: hasAnalyticsConsent(),
				},
			}, []);
		} catch (error) {
			analytics = undefined;
			throw error;
		}
	}

	const onConsentChanged = () => {
		void updateAnalytics().catch((error: unknown) => {
			console.error('Scope analytics could not update its consent state', error);
		});
	};
	const theme = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
	const initialTheme = theme();
	wcp.init(document.documentElement.lang || 'en-US', banner, (error, consent) => {
		if (error || !consent) {
			console.error('Scope cookie consent could not initialize', error ?? new Error('Missing consent manager'));
			return;
		}
		siteConsent = consent;
		manageCookies.hidden = false;
		manageCookies.addEventListener('click', () => consent.manageConsent());
		onConsentChanged();
		let appliedTheme = initialTheme;
		const applyTheme = () => {
			const nextTheme = theme();
			if (nextTheme === appliedTheme) return;
			appliedTheme = nextTheme;
			consent.applyTheme(nextTheme);
		};
		applyTheme();
		new MutationObserver(applyTheme).observe(
			document.documentElement,
			{ attributes: true, attributeFilter: ['data-theme'] },
		);
	}, onConsentChanged, initialTheme);
}

const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
const onPublishedSite =
	import.meta.env.PROD &&
	window.location.origin === 'https://microsoft.github.io' &&
	window.location.pathname.startsWith(base);
const previewConsent = import.meta.env.DEV && import.meta.env.PUBLIC_CONSENT_PREVIEW === 'true';
if (onPublishedSite || previewConsent) {
	void initializeConsent(onPublishedSite).catch((error: unknown) => {
		console.error('Scope cookie consent is unavailable; analytics remains disabled', error);
	});
}
