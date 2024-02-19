import { ResolvedPopoutLayoutConfig } from '../config/resolved-config';
import { UnexpectedNullError, UnexpectedUndefinedError } from '../errors/internal-error';
import { ComponentItem } from '../items/component-item';
import { ContentItem } from '../items/content-item';
import { Stack } from '../items/stack';
import { LayoutManager } from '../layout-manager';
import { DomConstants } from '../utils/dom-constants';
import { EventEmitter } from '../utils/event-emitter';
import { Side, WidthAndHeight } from '../utils/types';
import {
    getUniqueId,
    getWindowInnerScreenPosition,
    numberToPixels
} from '../utils/utils';
import { DragAction } from './drag-action';

/**
 * This class creates a temporary container
 * for the component whilst it is being dragged
 * and handles drag events
 * @internal
 */
export class DragProxy extends EventEmitter {
    private _outerWidth: number;
    private _outerHeight: number;
    private _sided: boolean;
    private _element: HTMLElement;
    private _proxyContainerElement: HTMLElement;
    private _componentItemFocused: boolean;
    private readonly _originalSize: WidthAndHeight;
    private readonly _dockPoint: ContentItem.DockPoint | null;
    private readonly _groundArea: ContentItem.Area;
    private _lastArea: ContentItem.Area | null = null;

    get element(): HTMLElement { return this._element; }
    get outerWidth(): number { return this._outerWidth; }
    get outerHeight(): number { return this._outerHeight; }
    get componentItem(): ComponentItem { return this._componentItem; }
    get layoutManager(): LayoutManager { return this._action.layoutManager; }

    /**
     * @param x - The initial x position
     * @param y - The initial y position
     * @internal
     */
    constructor(
        private readonly _action: DragAction,
        private readonly _componentItem: ComponentItem,
        x: number, y: number
    ) {
        super();

        let sizedComponent = this._componentItem;

        // If we are dragging an inactive component of a stack, we won't be able to get reasonable
        // size for a popout. Use the size of the active component instead in this case.
        if (this._componentItem.parent instanceof Stack) {
            const active = this._componentItem.parent.getActiveComponentItem();
            if (active) {
                sizedComponent = active;
            }
        }

        this._originalSize = sizedComponent.getOuterBoundingClientRect();
        this.createDragProxyElements(x, y);

        if (this._componentItem.parent === null) {
            // Note that _contentItem will have dummy GroundItem as parent if initiated by a external drag source
            throw new UnexpectedNullError('DPC10097');
        }

        this._componentItemFocused = this._componentItem.focused;
        if (this._componentItemFocused) {
            this._componentItem.blur();
        }

        this._dockPoint = this._componentItem.findDockPoint();

        if (this._componentItem.parent.contentItems.includes(this._componentItem)) {
            this._componentItem.parent.removeChild(this._componentItem, true);
        }

        this.setDimensions();

        document.body.appendChild(this._element);

        if (this.layoutManager.groundItem === undefined) {
            throw new UnexpectedUndefinedError('DPC10098');
        }

        this._groundArea = this.layoutManager.groundItem.getElementArea();
        this.layoutManager.calculateItemAreas();
        this.setDropPosition(x, y);
    }

    /** Create Stack-like structure to contain the dragged component */
    private createDragProxyElements(initialX: number, initialY: number): void {
        this._element = document.createElement('div');
        this._element.classList.add(DomConstants.ClassName.DragProxy);
        const headerElement = document.createElement('div');
        headerElement.classList.add(DomConstants.ClassName.Header);
        const tabsElement = document.createElement('div');
        tabsElement.classList.add(DomConstants.ClassName.Tabs);
        const tabElement = document.createElement('div');
        tabElement.classList.add(DomConstants.ClassName.Tab);
        const titleElement = document.createElement('span');
        titleElement.classList.add(DomConstants.ClassName.Title);
        tabElement.appendChild(titleElement);
        tabsElement.appendChild(tabElement);
        headerElement.appendChild(tabsElement);

        this._proxyContainerElement = document.createElement('div');
        this._proxyContainerElement.classList.add(DomConstants.ClassName.Content);

        this._element.appendChild(headerElement);
        this._element.appendChild(this._proxyContainerElement);

        const side = this._componentItem.headerConfig?.show;
        if (side) {
            this._sided = [Side.right, Side.left].includes(side);
            this._element.classList.add('lm_' + side);
            if ([Side.right, Side.bottom].indexOf(side) >= 0) {
                this._proxyContainerElement.insertAdjacentElement('afterend', headerElement);
            }
        }
        
        this._element.style.left = numberToPixels(initialX);
        this._element.style.top = numberToPixels(initialY);
        tabElement.setAttribute('title', this._componentItem.title);
        titleElement.insertAdjacentText('afterbegin', this._componentItem.title);
        this._proxyContainerElement.appendChild(this._componentItem.element);
    }

    /**
     * Callback on every mouseMove event during a drag. Determines if the drag is
     * still within the valid drag area and calls the layoutManager to highlight the
     * current drop area
     *
     * @internal
     */
    drag(x: number, y: number): ContentItem.Area | null {
        const area = this.setDropPosition(x, y);
        this._componentItem.drag();
        return area;
    }

    /**
     * Sets the target position
     *
     * @param x - The x position in px
     * @param y - The y position in px
     *
     * @internal
     */
    private setDropPosition(x: number, y: number): ContentItem.Area | null {
        this._element.style.left = numberToPixels(x);
        this._element.style.top = numberToPixels(y);

        const area = this.layoutManager.getArea(x, y);

        // If we have no matching area, return the last area instead (unless we are out of bounds of the ground item).
        // Avoids issues with splitters which don't have an area themselves.
        if (area !== null || x < this._groundArea.x1 || x >= this._groundArea.x2 || y < this._groundArea.y1 || y >= this._groundArea.y2) {
            this._lastArea = area;
        }

        return this._lastArea;
    }

    /**
     * Callback when the drag has finished. Determines the drop area
     * and adds the child to it
     * @internal
     */
    drop(): void {
        this._componentItem.exitDragMode();

        let area: ContentItem.Area | null = null;
        let droppedComponentItem: ComponentItem | null = null;

        const target = this._action.currentTarget;
        if (target?.owner === this._action) {
            area = target.area;
        }

        /*
        * Valid drop area found
        */
        if (area !== null) {
            droppedComponentItem = this._componentItem;
            const newParentContentItem = area.contentItem;
            newParentContentItem.onDrop(droppedComponentItem, area);
            this.layoutManager.focusWindow();

        /**
         * No valid drop area found during the duration of the drag.
         * Create a popout.
         */
        } else if (target === null && this._action.parent === null) {
            const innerScreen = getWindowInnerScreenPosition(globalThis);

            const window : ResolvedPopoutLayoutConfig.Window = {
                left: innerScreen.left + this.element.offsetLeft,
                top: innerScreen.top + this.element.offsetTop,
                width: this._originalSize.width,
                height: this._originalSize.height
            }

            this.layoutManager.createPopoutFromContentItem(this._componentItem, window, getUniqueId(), this._dockPoint);
            this._componentItem.destroy();

        /**
         * The drag didn't ultimately end up with adding the content item to
         * any container. In order to ensure clean up happens, destroy the
         * content item.
         */
        } else {
            this._componentItem.destroy(); // contentItem children are now destroyed as well
        }

        this.layoutManager.emit('itemDropped', this._componentItem);

        if (this._componentItemFocused) {
            droppedComponentItem?.focus();
        }

        this._element.remove();
    }

    /**
     * Updates the Drag Proxy's dimensions
     * @internal
     */
    private setDimensions() {
        const dimensions = this.layoutManager.layoutConfig.dimensions;
        if (dimensions === undefined) {
            throw new Error('DragProxy.setDimensions: dimensions undefined');
        }

        let width = dimensions.dragProxyWidth;
        let height = dimensions.dragProxyHeight;
        if (width === undefined || height === undefined) {
            throw new Error('DragProxy.setDimensions: width and/or height undefined');
        }

        this._outerWidth = width;
        this._outerHeight = height;
        const headerHeight = this.layoutManager.layoutConfig.header.show === false ? 0 : dimensions.headerHeight;
        this._element.style.width = numberToPixels(width);
        this._element.style.height = numberToPixels(height)
        width -= (this._sided ? headerHeight : 0);
        height -= (!this._sided ? headerHeight : 0);
        this._proxyContainerElement.style.width = numberToPixels(width);
        this._proxyContainerElement.style.height = numberToPixels(height);
        this._componentItem.enterDragMode(width, height);
        this._componentItem.show();
    }
}
