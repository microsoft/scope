// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

class ScopeShowreel extends HTMLElement {
	private events: AbortController | undefined;
	private observer: IntersectionObserver | undefined;

	connectedCallback() {
		const video = this.querySelector('video');
		const button = this.querySelector('button');
		const status = this.querySelector<HTMLElement>('[role="status"]');
		const source = video?.dataset.src;
		if (!video || !button || !status || !source) throw new Error('Missing Scope showreel elements');

		this.events = new AbortController();
		const { signal } = this.events;
		const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
		let wantsPlayback = !motion.matches;
		let visible = false;
		let playbackRequest = 0;

		video.muted = true;
		button.hidden = false;
		button.disabled = false;

		const renderPlayback = () => {
			button.textContent = video.paused ? 'Play showreel' : 'Pause showreel';
		};
		const reportFailure = (error: unknown) => {
			wantsPlayback = false;
			video.pause();
			status.textContent = 'The showreel is unavailable.';
			status.hidden = false;
			button.disabled = true;
			console.error('Scope showreel failed', error);
		};
		const syncPlayback = () => {
			const request = ++playbackRequest;
			video.autoplay = wantsPlayback && visible && !document.hidden;
			if (!video.autoplay) {
				video.pause();
				return;
			}
			if (!video.getAttribute('src')) video.src = source;
			if (!video.paused) return;
			void video.play().catch((error: unknown) => {
				// Pausing or a newer play request can invalidate a pending promise.
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
			syncPlayback();
		}, { signal });
		video.addEventListener('play', renderPlayback, { signal });
		video.addEventListener('pause', renderPlayback, { signal });
		video.addEventListener('playing', () => { status.hidden = true; }, { signal });
		video.addEventListener('error', () => reportFailure(video.error), { signal });
		motion.addEventListener('change', () => {
			if (motion.matches) wantsPlayback = false;
			syncPlayback();
		}, { signal });
		document.addEventListener('visibilitychange', syncPlayback, { signal });
		this.observer = new IntersectionObserver(([entry]) => {
			visible = entry.isIntersecting;
			syncPlayback();
		}, { threshold: 0.25 });
		this.observer.observe(this);
		renderPlayback();
	}

	disconnectedCallback() {
		this.events?.abort();
		this.observer?.disconnect();
		const video = this.querySelector('video');
		if (video) {
			video.autoplay = false;
			video.pause();
		}
	}
}

if (!customElements.get('scope-showreel')) customElements.define('scope-showreel', ScopeShowreel);
