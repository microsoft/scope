// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

type Theme = 'dark' | 'light';

// Starlight resolves 'auto' and writes 'dark' or 'light'; the site CSS treats anything else as dark.
const activeTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

class ScopeShowreel extends HTMLElement {
	private events: AbortController | undefined;
	private observer: IntersectionObserver | undefined;
	private themeObserver: MutationObserver | undefined;

	connectedCallback() {
		const video = this.querySelector('video');
		const button = this.querySelector('button');
		const status = this.querySelector<HTMLElement>('[role="status"]');
		const dark = video?.dataset.srcDark;
		const light = video?.dataset.srcLight;
		if (!video || !button || !status || !dark || !light) throw new Error('Missing Scope showreel elements');
		const sources: Record<Theme, string> = { dark, light };

		this.events = new AbortController();
		const { signal } = this.events;
		const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
		let wantsPlayback = !motion.matches;
		let intersecting = false;
		// At least a quarter is on screen.
		let visible = false;
		// The user pressed Play while part of the player was on screen; holds until it leaves the viewport.
		let manualPlay = false;
		let failed = false;
		let playbackRequest = 0;
		// Position to restore once a theme swap's new source has metadata.
		let pendingStart: number | undefined;

		video.muted = true;
		button.hidden = false;
		button.disabled = false;

		const themeSource = () => sources[activeTheme()];
		const renderPlayback = () => {
			button.textContent = video.paused ? 'Play showreel' : 'Pause showreel';
		};
		const reportFailure = (error: unknown) => {
			wantsPlayback = false;
			failed = true;
			video.pause();
			// Fall back to the CSS poster, which keeps following the theme.
			delete video.dataset.ready;
			status.textContent = 'The showreel is unavailable.';
			status.hidden = false;
			button.disabled = true;
			console.error('Scope showreel failed', error);
		};
		// Until the video has a frame at the right position, it stays transparent over the CSS poster.
		const markReady = () => {
			if (failed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.seeking) return;
			pendingStart = undefined;
			video.dataset.ready = '';
		};
		// Only an assigned source can show the wrong theme; an unassigned player just shows the CSS poster.
		const sourceIsStale = () => {
			const assigned = video.getAttribute('src');
			return !failed && assigned !== null && assigned !== themeSource();
		};
		const swapSource = () => {
			const start = pendingStart ?? video.currentTime;
			// A paused player that showed a frame keeps showing one; one that showed the poster keeps it.
			const showsFrame = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || video.preload !== 'none';
			pendingStart = start;
			delete video.dataset.ready;
			// Playback fetches on demand, and a paused frame only needs the data at its position.
			video.preload = !wantsPlayback && showsFrame ? 'metadata' : 'none';
			video.src = themeSource();
			video.currentTime = start;
			renderPlayback();
		};
		const syncPlayback = () => {
			const request = ++playbackRequest;
			const onScreen = (visible || manualPlay) && !document.hidden;
			// Off-screen players keep their current source and position until they are seen again.
			if (onScreen && sourceIsStale()) swapSource();
			video.autoplay = wantsPlayback && onScreen;
			if (!video.autoplay) {
				video.pause();
				return;
			}
			if (!video.getAttribute('src')) video.src = themeSource();
			if (!video.paused) return;
			void video.play().catch((error: unknown) => {
				// Pausing, a theme swap, or a newer play request can invalidate a pending promise.
				if (request !== playbackRequest || signal.aborted) return;
				if (error instanceof DOMException && error.name === 'NotAllowedError') {
					wantsPlayback = false;
					renderPlayback();
					status.textContent = 'Autoplay is blocked. Select Play showreel to start.';
					status.hidden = false;
					return;
				}
				reportFailure(error);
			});
		};

		button.addEventListener('click', () => {
			wantsPlayback = video.paused;
			// An explicit Play overrides the autoplay threshold; Pause clears the override.
			manualPlay = wantsPlayback && intersecting;
			syncPlayback();
		}, { signal });
		video.addEventListener('play', renderPlayback, { signal });
		video.addEventListener('pause', renderPlayback, { signal });
		video.addEventListener('playing', () => { status.hidden = true; }, { signal });
		video.addEventListener('loadedmetadata', () => {
			// Fallback for browsers that ignore a start position set before metadata loads.
			if (pendingStart !== undefined && !video.seeking && Math.abs(video.currentTime - pendingStart) > 0.1) {
				video.currentTime = pendingStart;
			}
		}, { signal });
		video.addEventListener('loadeddata', markReady, { signal });
		video.addEventListener('seeked', markReady, { signal });
		video.addEventListener('error', () => reportFailure(video.error), { signal });
		motion.addEventListener('change', () => {
			if (motion.matches) wantsPlayback = false;
			syncPlayback();
		}, { signal });
		document.addEventListener('visibilitychange', syncPlayback, { signal });
		// The 0 threshold reports entering and leaving: Chrome keeps isIntersecting false below the smallest threshold.
		this.observer = new IntersectionObserver((entries) => {
			const entry = entries[entries.length - 1];
			intersecting = entry.isIntersecting;
			if (!intersecting) manualPlay = false;
			visible = intersecting && entry.intersectionRatio >= 0.25;
			syncPlayback();
		}, { threshold: [0, 0.25] });
		this.observer.observe(this);
		// The Starlight theme toggle rewrites data-theme on <html>; follow it with the matching cut.
		this.themeObserver = new MutationObserver(() => {
			if (sourceIsStale()) {
				// Hide the other cut at once, even when a partly visible player defers the swap.
				delete video.dataset.ready;
				syncPlayback();
			} else {
				// The theme flipped back to the assigned cut before its swap ran.
				markReady();
			}
		});
		this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		renderPlayback();
	}

	disconnectedCallback() {
		this.events?.abort();
		this.observer?.disconnect();
		this.themeObserver?.disconnect();
		const video = this.querySelector('video');
		if (video) {
			video.autoplay = false;
			video.pause();
		}
	}
}

if (!customElements.get('scope-showreel')) customElements.define('scope-showreel', ScopeShowreel);
