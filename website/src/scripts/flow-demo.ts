// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { sampleAgents, type SampleProfile } from './sample-agents';

interface DemoScenario {
	id: string;
	title: string;
	short: string;
	prompt: string;
	edge: string;
	context: string;
	passedCriteria: Record<SampleProfile, 0 | 1 | 2 | 3>;
}

const scenarios: Record<string, DemoScenario> = {
	board: {
		id: 'task-board',
		title: 'Build a task board',
		short: 'A small app. Real acceptance criteria.',
		prompt: 'Build a task board. Users can add tasks, mark them complete, and filter by status. An empty title must not create a task.',
		edge: 'Handles empty input',
		context: 'Create a task board with add, complete, and filter actions. Define the expected behavior before the agents start.',
		passedCriteria: { A: 3, B: 1, C: 2, D: 3, E: 0 },
	},
	api: {
		id: 'search-api',
		title: 'Add a search API',
		short: 'One endpoint. The details matter.',
		prompt: 'Add a paginated search endpoint. Return matching items, validate the page size, and return an empty list when nothing matches.',
		edge: 'Handles no matches',
		context: 'Add search with pagination and input validation. Give every sample profile the same task and the same acceptance criteria.',
		passedCriteria: { A: 1, B: 3, C: 3, D: 0, E: 2 },
	},
};

const headings = [
	'Give every agent the same starting line.',
	'Different agents. A repeatable setup.',
	'Success has a dependency graph.',
	'The result is only the beginning.',
];

class ScopeFlow extends HTMLElement {
	private stage = 0;
	private scenario = scenarios.board;
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
		this.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach((control) => { control.disabled = false; });
		this.addEventListener('click', (event) => {
			if (!(event.target instanceof Element)) return;
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
		this.querySelector('select')?.addEventListener('change', (event) => {
			if (!(event.target instanceof HTMLSelectElement)) return;
			const scenario = scenarios[event.target.value];
			if (!scenario) throw new Error('Unknown Scope demo scenario');
			this.interacted = true;
			this.stop();
			this.scenario = scenario;
			this.stage = 0;
			this.render();
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
		this.render(false);
	}

	private text(selector: string, value: string) {
		const element = this.querySelector(selector);
		if (!element) throw new Error(`Missing Scope demo element: ${selector}`);
		element.textContent = value;
	}

	private render(announce = true) {
		this.dataset.stage = String(this.stage);
		this.dataset.playing = String(this.playing);
		this.text('[data-experiment]', this.scenario.id);
		this.text('[data-task-title]', this.scenario.title);
		this.text('[data-task-short]', this.scenario.short);
		this.text('[data-edge-label]', this.scenario.edge);
		this.text('[data-play]', this.motion.matches ? (this.stage === 3 ? 'Start again' : 'Next step') : this.playing ? 'Pause demo' : this.stage === 3 ? 'Replay demo' : this.stage === 0 ? 'Play demo' : 'Resume demo');
		this.querySelectorAll<HTMLElement>('[data-step], [data-node]').forEach((element) => {
			const index = Number(element.dataset.step ?? element.dataset.node);
			if (index === this.stage) element.setAttribute('aria-current', 'step');
			else element.removeAttribute('aria-current');
			element.dataset.complete = String(index < this.stage);
		});
		this.querySelectorAll<HTMLElement>('[data-wire]').forEach((element) => {
			element.dataset.active = String(Number(element.dataset.wire) <= this.stage);
		});
		this.querySelectorAll('[data-agent-status]').forEach((element) => {
			element.textContent = this.stage === 0 ? 'Ready' : this.stage === 1 ? 'Working' : 'Complete';
		});
		this.text('[data-stage-label]', `Step 0${this.stage + 1} / ${['Define', 'Execute', 'Evaluate', 'Understand'][this.stage]}`);
		this.text('[data-detail-title]', headings[this.stage]);
		this.text('[data-detail-body]', [
			this.scenario.context,
			'Each sample profile brings its own agent configuration. In Scope, profiles capture the setup; logs and iterations show the work.',
			'In this example, tests depend on a successful build, and the edge-case criterion depends on passing tests. A failed parent leaves its child skipped.',
			'Inspect criterion feedback rather than choosing an agent from a single score. These invented outcomes only demonstrate how to read the evidence.',
		][this.stage]);
		const panel = this.querySelector('[data-detail-panel]');
		if (!panel) throw new Error('Missing Scope demo detail panel');
		panel.replaceChildren();
		if (this.stage === 0) {
			this.appendText(panel, 'span', 'TASK PROMPT / EXAMPLE', 'flow-code-label');
			this.appendText(panel, 'p', this.scenario.prompt);
		} else if (this.stage === 1) {
			this.appendText(panel, 'span', 'SIMULATED ACTIVITY', 'flow-code-label');
			for (const line of ['01  Load task and profile configuration', '02  Agent edits the workspace', '03  Capture logs and iteration evidence']) {
				this.appendText(panel, 'p', line, 'flow-log-line');
			}
		} else {
			const table = document.createElement('table');
			table.className = 'flow-results';
			const caption = table.createCaption();
			caption.textContent = 'Invented criterion outcomes, not an agent comparison';
			const row = table.createTHead().insertRow();
			for (const label of ['Sample agent', 'Builds', 'Tests pass', this.scenario.edge]) {
				const cell = document.createElement('th');
				cell.scope = 'col';
				cell.textContent = label;
				row.append(cell);
			}
			const body = table.createTBody();
			for (const agent of sampleAgents) {
				const row = body.insertRow();
				const header = document.createElement('th');
				header.scope = 'row';
				this.appendText(header, 'span', agent.name);
				this.appendText(header, 'span', `Profile ${agent.profile}`, 'flow-result-profile');
				row.append(header);
				for (let index = 0; index < 3; index += 1) {
					const passed = this.scenario.passedCriteria[agent.profile];
					const state = index < passed ? 'Pass' : index === passed ? 'Fail' : 'Skipped';
					const cell = row.insertCell();
					cell.textContent = state;
					cell.dataset.result = state.toLowerCase();
				}
			}
			panel.append(table);
		}
		if (announce) this.text('[data-announcement]', `${this.scenario.title}. Step ${this.stage + 1} of 4. ${headings[this.stage]}${this.stage === 3 ? ' Demo complete. Results are fictional.' : ''}`);
	}

	private appendText(parent: Element, tag: 'span' | 'p', text: string, className?: string) {
		const element = document.createElement(tag);
		element.textContent = text;
		if (className) element.className = className;
		parent.append(element);
	}
}

if (!customElements.get('scope-flow')) customElements.define('scope-flow', ScopeFlow);
