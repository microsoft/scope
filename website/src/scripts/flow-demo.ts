// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { sampleProfiles } from './sample-agents';
import { criterionOutcomes, demoCriteria, demoGates, exampleScenario, formatDelta, formatDuration, gateOutcomes, passedGateCount, totalTokens } from './flow-demo-data';

const headings = [
	'Give every agent the same starting line.',
	'Start with a base. Change the setup.',
	'Gates are stages. Criteria define success.',
	'Compare quality, tokens, and time.',
];

class ScopeFlow extends HTMLElement {
	private stage = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private playing = false;
	private observer: IntersectionObserver | undefined;
	private events: AbortController | undefined;
	private motion = window.matchMedia('(prefers-reduced-motion: reduce)');
	private visible = false;
	private interacted = false;

	connectedCallback() {
		this.events = new AbortController();
		const { signal } = this.events;
		this.querySelectorAll<HTMLButtonElement>('button').forEach((control) => { control.disabled = false; });
		this.addEventListener('click', (event) => {
			if (!(event.target instanceof Element)) return;
			if (event.target.closest('summary')) {
				this.interacted = true;
				this.stop();
				return;
			}
			const button = event.target.closest('button');
			if (!button) return;
			this.interacted = true;
			if (button.hasAttribute('data-play')) {
				if (this.motion.matches) {
					this.stop();
					this.stage = (this.stage + 1) % 4;
					this.render();
				} else if (this.playing) {
					this.stop();
				} else {
					if (this.stage === 3) this.stage = 0;
					this.playing = true;
					this.render();
					this.schedule();
				}
			} else if (button.hasAttribute('data-reset')) {
				this.stop();
				this.stage = 0;
				this.render();
			} else {
				const step = button.dataset.step ?? button.dataset.node;
				if (step !== undefined) {
					this.stop();
					this.stage = Number(step);
					this.render();
				}
			}
		}, { signal });
		this.motion.addEventListener('change', () => this.stop(), { signal });
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) this.stop();
		}, { signal });
		this.observer = new IntersectionObserver(([entry]) => {
			this.visible = entry.isIntersecting;
			if (!this.visible) {
				this.stop();
			} else if (!this.interacted && !this.motion.matches && !document.hidden) {
				this.interacted = true;
				this.playing = true;
				this.render();
				this.schedule();
			}
		}, { threshold: 0.25 });
		this.observer.observe(this);
		this.render(false);
	}

	disconnectedCallback() {
		clearTimeout(this.timer);
		this.observer?.disconnect();
		this.events?.abort();
	}

	private schedule() {
		clearTimeout(this.timer);
		if (!this.playing || !this.visible || document.hidden) return;
		this.timer = setTimeout(() => {
			this.stage += 1;
			if (this.stage === 3) this.playing = false;
			this.render();
			if (this.playing) this.schedule();
		}, 2400);
	}

	private stop() {
		clearTimeout(this.timer);
		this.playing = false;
		// Pausing must not replace an open disclosure or its focused contents.
		this.renderPlayback();
	}

	private renderPlayback() {
		this.dataset.playing = String(this.playing);
		this.text('[data-play]', this.motion.matches ? (this.stage === 3 ? 'Start again' : 'Next step') : this.playing ? 'Pause animation' : this.stage === 3 ? 'Replay animation' : this.stage === 0 ? 'Play animation' : 'Resume animation');
	}

	private text(selector: string, value: string) {
		const elements = this.querySelectorAll(selector);
		if (elements.length === 0) throw new Error(`Missing Scope demo element: ${selector}`);
		elements.forEach((element) => { element.textContent = value; });
	}

	private render(announce = true) {
		this.dataset.stage = String(this.stage);
		this.renderPlayback();
		const explorer = this.querySelector<HTMLElement>('[data-criteria-explorer]');
		if (!explorer) throw new Error('Missing Scope demo criteria explorer');
		explorer.hidden = this.stage !== 2;
		this.querySelectorAll<HTMLElement>('[data-step], [data-node]').forEach((element) => {
			const index = Number(element.dataset.step ?? element.dataset.node);
			if (index === this.stage) element.setAttribute('aria-current', 'step');
			else element.removeAttribute('aria-current');
			element.dataset.complete = String(index < this.stage);
		});
		this.querySelectorAll<HTMLElement>('[data-wire]').forEach((element) => {
			element.dataset.active = String(Number(element.dataset.wire) <= this.stage);
		});
		this.text('[data-stage-label]', `Step 0${this.stage + 1} / ${['Define', 'Execute', 'Evaluate', 'Understand'][this.stage]}`);
		this.text('[data-detail-title]', headings[this.stage]);
		this.text('[data-detail-body]', [
			exampleScenario.context,
			'Keep the task and criteria fixed. Compare the base profile with an alternate that adds a skill, or one that changes the agent and model. Each profile gets its own run.',
			'The judge evaluates each gate using checks selected from your library of reusable criteria. This example uses Requirements, Build, and Test gates. If a gate fails after its iteration budget, later gates are skipped.',
			'Read each variation against the base profile, including input/output tokens and run duration. A faster failed run is not a better result. These numbers and outcomes are fictional, not measured comparisons.',
		][this.stage]);
		const panel = this.querySelector('[data-detail-panel]');
		if (!panel) throw new Error('Missing Scope demo detail panel');
		const evidenceOpen = panel.querySelector<HTMLDetailsElement>('.flow-result-evidence')?.open ?? false;
		panel.replaceChildren();
		if (this.stage === 0) {
			this.appendText(panel, 'span', 'TASK PROMPT / EXAMPLE', 'flow-code-label');
			this.appendText(panel, 'p', exampleScenario.prompt);
		} else if (this.stage === 1) {
			this.appendText(panel, 'span', 'SAME TASK / BASE + ALTERNATE PROFILES', 'flow-code-label');
			for (const profile of sampleProfiles) {
				const item = document.createElement('div');
				item.className = 'flow-profile-setup';
				this.appendText(item, 'span', profile.label, 'flow-profile-label').dataset.base = String(profile.id === 'base');
				this.appendText(item, 'strong', `${profile.agent.name} / ${profile.name}`);
				this.appendText(item, 'p', profile.setup);
				panel.append(item);
			}
		} else if (this.stage === 2) {
			this.appendText(panel, 'span', 'REUSABLE CRITERIA LIBRARY / EXAMPLE SELECTION', 'flow-code-label');
			for (const gate of demoGates) {
				const group = document.createElement('div');
				group.className = 'flow-library-group';
				this.appendText(group, 'strong', `${gate.label} gate`);
				for (const criterion of demoCriteria.filter((item) => item.gate === gate.id)) {
					this.appendText(group, 'span', criterion.label, 'flow-library-criterion');
				}
				panel.append(group);
			}
		} else {
			this.renderResults(panel);
			const evidence = panel.querySelector<HTMLDetailsElement>('.flow-result-evidence');
			if (evidence) evidence.open = evidenceOpen;
		}
		if (announce) this.text('[data-announcement]', `${exampleScenario.title}. Step ${this.stage + 1} of 4. ${headings[this.stage]}${this.stage === 3 ? ' Example complete. Results are fictional.' : ''}`);
	}

	private renderResults(panel: Element) {
		const body = this.createTable(panel, ['Profile', 'Gates passed', 'Tokens (input + output)', 'Run duration'], `${exampleScenario.title} / mock outcomes and metrics`);
		for (const profile of sampleProfiles) {
			const result = exampleScenario.results[profile.id];
			const base = exampleScenario.results.base;
			const row = body.insertRow();
			row.dataset.profile = profile.id;
			this.profileHeader(row, profile);
			const gates = gateOutcomes(result);
			const gateCell = row.insertCell();
			this.appendText(gateCell, 'strong', `${passedGateCount(result)} / ${demoGates.length}`);
			for (const [index, gate] of demoGates.entries()) {
				const state = document.createElement('span');
				state.className = 'flow-result-detail';
				state.dataset.result = gates[index].toLowerCase();
				state.textContent = `${gate.label}: ${gates[index]}`;
				gateCell.append(state);
			}
			const tokens = row.insertCell();
			this.appendText(tokens, 'strong', totalTokens(result).toLocaleString('en-US'));
			this.appendText(tokens, 'span', `${result.inputTokens.toLocaleString('en-US')} in / ${result.outputTokens.toLocaleString('en-US')} out`, 'flow-result-detail');
			this.appendText(tokens, 'span', profile.id === 'base' ? 'Reference' : formatDelta(totalTokens(result), totalTokens(base), 'tokens'), 'flow-metric-delta');
			const duration = row.insertCell();
			this.appendText(duration, 'strong', formatDuration(result.durationSeconds));
			this.appendText(duration, 'span', profile.id === 'base' ? 'Reference' : formatDelta(result.durationSeconds, base.durationSeconds, 'sec'), 'flow-metric-delta');
		}
		this.appendText(panel, 'p', 'Tokens = input + output. Duration = elapsed run time, not this animation. Deltas compare each sample run with the base; less is not automatically better.', 'flow-metric-note');
		const details = document.createElement('details');
		details.className = 'flow-result-evidence';
		const summary = document.createElement('summary');
		summary.textContent = 'Inspect per-criterion outcomes';
		details.append(summary);
		const outcomes = this.createTable(details, ['Profile', ...demoCriteria.map((criterion) => criterion.label)], `${exampleScenario.title} / mock criterion outcomes; skipped checks were not evaluated`);
		for (const profile of sampleProfiles) {
			const row = outcomes.insertRow();
			this.profileHeader(row, profile);
			for (const outcome of criterionOutcomes(exampleScenario.results[profile.id]).values()) {
				const cell = row.insertCell();
				cell.textContent = outcome;
				cell.dataset.result = outcome.toLowerCase();
			}
		}
		panel.append(details);
	}

	private createTable(parent: Element, headings: string[], captionText: string): HTMLTableSectionElement {
		this.appendText(parent, 'p', 'Scroll horizontally to see all columns.', 'flow-table-hint');
		const container = document.createElement('div');
		container.className = 'flow-table-scroll';
		container.tabIndex = 0;
		container.setAttribute('role', 'region');
		container.setAttribute('aria-label', captionText);
		const table = document.createElement('table');
		table.className = 'flow-results';
		table.createCaption().textContent = captionText;
		const row = table.createTHead().insertRow();
		for (const label of headings) {
			const cell = document.createElement('th');
			cell.scope = 'col';
			cell.textContent = label;
			row.append(cell);
		}
		container.append(table);
		parent.append(container);
		return table.createTBody();
	}

	private profileHeader(row: HTMLTableRowElement, profile: typeof sampleProfiles[number]) {
		const header = document.createElement('th');
		header.scope = 'row';
		this.appendText(header, 'span', profile.label, 'flow-profile-label').dataset.base = String(profile.id === 'base');
		this.appendText(header, 'strong', profile.name);
		this.appendText(header, 'span', profile.agent.name, 'flow-result-detail');
		row.append(header);
	}

	private appendText(parent: Element, tag: 'span' | 'p' | 'strong', text: string, className?: string) {
		const element = document.createElement(tag);
		element.textContent = text;
		if (className) element.className = className;
		parent.append(element);
		return element;
	}
}

if (!customElements.get('scope-flow')) customElements.define('scope-flow', ScopeFlow);
