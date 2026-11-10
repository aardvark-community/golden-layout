import { GoldenLayout, LayoutConfig } from '../..';
import TestTools from './test-tools';

// A popout window closes, but BrowserPopout emits 'closed' only 50 ms later (_onClose), and reconcilePopoutWindows
// removes the entry from openPopouts on that event. A tab drag that starts in those 50 ms spawned a drag in every
// listed instance, the closed window's included, where computeBoundingRect throws
// "TypeError: Cannot read properties of undefined (reading 'fromRect')".
describe('a tab drag while a popout window has just closed', function() {

	let layout: GoldenLayout;
	let stand: { closed: StandIn, open: StandIn };

	interface StandIn {
		popout: { getWindow: () => { closed: boolean }, getGlInstance: () => unknown },
		spawned: jasmine.Spy
	}

	/** An openPopouts entry whose window is closed or open, with a GoldenLayout instance that records drags spawned in it. */
	function standIn(closed: boolean): StandIn {
		const spawned = jasmine.createSpy(closed ? 'spawned in the closed window' : 'spawned in the open window');
		const instance = { startExternalComponentDrag: spawned };
		return { popout: { getWindow: () => ({ closed }), getGlInstance: () => instance }, spawned };
	}

	function openPopouts(): unknown[] {
		return (layout as unknown as { _openPopouts: unknown[] })._openPopouts;
	}

	beforeEach(function () {
		const config: LayoutConfig = {
			settings: { dragBetweenWindows: true },
			root: {
				type: 'stack',
				content: [
					{ type: 'component', componentType: TestTools.TEST_COMPONENT_NAME, title: 'first' },
					{ type: 'component', componentType: TestTools.TEST_COMPONENT_NAME, title: 'second' }
				]
			}
		};
		layout = TestTools.createLayout(config);
		stand = { closed: standIn(true), open: standIn(false) };
		// The closed window's entry is still listed: its 'closed' event has not been emitted yet.
		openPopouts().push(stand.closed.popout, stand.open.popout);
	});

	afterEach(function () {
		// The stand-ins have no window to close.
		openPopouts().length = 0;
		layout.destroy();
	});

	function dragFirstTab(): void {
		const tab = layout.container.querySelector('.lm_tab') as HTMLElement;
		const rect = tab.getBoundingClientRect();
		const x = rect.left + 5, y = rect.top + 5;
		tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0, clientX: x, clientY: y }));
		// Past the drag threshold.
		for (let step = 1; step <= 30; step++) {
			document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, isPrimary: true, clientX: x + step * 4, clientY: y + step * 4 }));
		}
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true }));
	}

	it('starts the drag in the open popout only, not in the closed one', function() {
		dragFirstTab();
		expect(stand.open.spawned).toHaveBeenCalledTimes(1);
		expect(stand.closed.spawned).not.toHaveBeenCalled();
	});
});
