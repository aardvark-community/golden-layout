import { DragProxy } from './drag-proxy';
import { LayoutManager } from '../layout-manager';
import { UnexpectedNullError, UnexpectedUndefinedError } from '../errors/internal-error';
import { EventEmitter } from '../utils/event-emitter';
import { ContentItem } from '../items/content-item';
import { ComponentItem } from '../items/component-item';
import { DragListener } from '../utils/drag-listener';

/** @internal */
class DragTarget {
    constructor(
        private readonly _owner: DragAction,
        private readonly _area: ContentItem.Area,
        private readonly _pageX: number,
        private readonly _pageY: number) {
        if (_owner.layoutManager !== _area.contentItem.layoutManager) {
            throw Error('LayoutManager of Area and DragProxy must match');
        }
    }

    get owner(): DragAction { return this._owner; }
    get area(): ContentItem.Area { return this._area; }

    drop(item: ComponentItem) {
        this._area.contentItem.onDrop(item, this._area);
    }

    highlightDropZone() {
        this.area.contentItem.highlightDropZone(this._pageX, this._pageY, this._area);
    }
}

/** @internal */
export class DragAction extends EventEmitter {
    private _dragProxy: DragProxy | null = null;
    private _currentTarget: DragTarget | null = null;
    private _dragListener: DragListener | null = null;
    private _boundingRect: DOMRect;
    private _actions: DragAction[] = [];

    private readonly _dragEventHandler = (event: EventEmitter.DragEvent) => this.onDrag(event);
    private readonly _dragStopEventHandler = () => this.onDragStop();

    get layoutManager(): LayoutManager { return this._layoutManager; }
    get parent(): DragAction | null { return this._parent; }
    get proxy(): DragProxy | null { return this._dragProxy; }
    private get parentOrSelf(): DragAction { return this._parent ?? this; }
    get currentTarget(): DragTarget | null { return this.parentOrSelf._currentTarget; }
    private set currentTarget(value : DragTarget | null) { this.parentOrSelf._currentTarget = value; }

    private constructor(
        private readonly _layoutManager: LayoutManager,
        private readonly _parent: DragAction | null = null
    ) {
        super();
        this._boundingRect = this.computeBoundingRect();
        this.parentOrSelf._actions.push(this);
        this._actions.push(this);
    }

    private computeBoundingRect(): DOMRect {
        if (this._layoutManager.groundItem === undefined) {
            throw new UnexpectedUndefinedError('DACBR11120');
        } else {
            const rect = this._layoutManager.groundItem.element.getBoundingClientRect();
            return DOMRect.fromRect({
                x: document.body.scrollLeft + rect.left,
                y: document.body.scrollTop + rect.top,
                width: rect.width,
                height: rect.height
            });
        }
    }

    private screenToPage(screenX: number, screenY: number) {
        let innerScreenX: number | undefined = (<any>globalThis).mozInnerScreenX;
        let innerScreenY: number | undefined = (<any>globalThis).mozInnerScreenY;

        if (innerScreenX === undefined || innerScreenY === undefined) {
            const borderX = (globalThis.outerWidth - globalThis.innerWidth) / 2;        // Assume left / right border is the same
            const borderY = globalThis.outerHeight - globalThis.innerHeight - borderX;  // Assume bottom border is the same as left / right
            innerScreenX = globalThis.screenX + borderX;
            innerScreenY = globalThis.screenY + borderY;
        }

        return {
            x: document.body.scrollLeft + screenX - innerScreenX,
            y: document.body.scrollTop + screenY - innerScreenY
        };
    }

    private isProxyVisible(proxy: DragProxy, pageX : number, pageY: number) {
        return (
            pageX >= this._boundingRect.left - proxy.outerWidth &&
            pageX < this._boundingRect.right &&
            pageY >= this._boundingRect.top - proxy.outerHeight &&
            pageY < this._boundingRect.bottom
        );
    }

    private createProxy(item: ComponentItem, parentItem: ContentItem, x: number, y: number) {
        this._dragProxy = new DragProxy(this, item, parentItem, x, y);
    }

    private dragLocal(pageX: number, pageY: number): DragTarget | null {
        if (this._dragProxy !== null) {
            const area = this._dragProxy.drag(pageX, pageY);
            return (area !== null) ? new DragTarget(this, area, pageX, pageY) : null;
        } else {
            return null;
        }
    }

    private dragGlobal(screenX: number, screenY: number): DragTarget | null {
        const source = this._parent?._dragProxy;
        if (!source) {
            throw new UnexpectedNullError('DADG1');
        }

        const { x: pageX, y: pageY } = this.screenToPage(screenX, screenY);
        const visible = document.visibilityState === 'visible' && this.isProxyVisible(source, pageX, pageY);

        if (visible) {
            if (this._dragProxy === null) {
                const parent = this.layoutManager.groundItem;
                
                if (parent === undefined) {
                    throw new UnexpectedUndefinedError('DADG2');
                }
                
                const config = source.componentItem.toConfig();
                const dragItem = new ComponentItem(this.layoutManager, config, parent);
                this.createProxy(dragItem, parent, pageX, pageY);
            }
        } else {
            // Proxy is no longer visible and not currently the drag target -> destroy
            if (this._dragProxy !== null && this.currentTarget?.owner !== this) {
                this.onDragStop();
            }
        }

        return this.dragLocal(pageX, pageY);
    }

    private onDragStop() {
        for (const action of this._actions) {
            action.layoutManager.hideDropTargetIndicator();
            action._dragProxy?.drop();
            action._dragProxy = null;
        }

        this._dragListener?.off('drag', this._dragEventHandler);
        this._dragListener?.off('dragStop', this._dragStopEventHandler);
        this._dragListener = null;
    }

    private onDrag(event: EventEmitter.DragEvent) {
        let target: DragTarget | null = null;
         
        // Try to find a drag target by invoking all actions.
        // For secondary actions the screen position of the event have to be translated.
        // The first valid target is selected, still we want to invoke all actions due to the culling logic in dragGlobal.
        for (const action of this._actions) {
            let t: DragTarget | null = null;

            if (action !== this) {
                t = action.dragGlobal(event.screenX, event.screenY);
            } else if (this._dragProxy !== null) {
                t = this.dragLocal(event.pageX, event.pageY);
            }

            if (target === null) {
                target = t;
            }
        }

        if (target !== null) {
            // If we already have a drop area but it is in a different window, hide the indicator.
            if (this.currentTarget !== null && this.currentTarget.owner !== target.owner) {
                this.currentTarget.owner.layoutManager.hideDropTargetIndicator();
            }

            // Move the owner of the target to the front, so it has the highest priority for future drag events.
            const index = this._actions.indexOf(target.owner);
            this._actions.splice(index, 1);
            this._actions.unshift(target.owner);

            target.highlightDropZone();
            target.owner.layoutManager.moveWindowTop();
            this.currentTarget = target;
        }
    }

    // Spawn a secondary drag action, the proxy element is only created when the pointer enters its window.
    static spawn(layoutManager: LayoutManager, parent: DragAction): DragAction {
        if (parent._parent !== null) {
            throw new Error('Secondary DragAction cannot spawn another DragAction.');
        }

        return new DragAction(layoutManager, parent);
    }

    // Start a drag action, immediately showing a proxy element.
    static start(layoutManager: LayoutManager, listener: DragListener, item: ComponentItem, parentItem: ContentItem, x: number, y: number): DragAction {
        const action = new DragAction(layoutManager);
        action.createProxy(item, parentItem, x, y);
        action._dragListener = listener;
        listener.on('drag', action._dragEventHandler);
        listener.on('dragStop', action._dragStopEventHandler);
        return action;
    }
}