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
    private _minX: number;
    private _minY: number;
    private _maxX: number;
    private _maxY: number;
    private _outerWidth: number;
    private _outerHeight: number;
    private _sided: boolean;
    private _element: HTMLElement;
    private _proxyContainerElement: HTMLElement;
    private _componentItemFocused: boolean;
    private readonly _originalSize: WidthAndHeight;

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
        private readonly _originalStack: Stack | null,
        x: number, y: number
    ) {
        super();

        this._originalSize = this._componentItem.getOuterBoundingClientRect();
        this.createDragProxyElements(x, y);

        if (this._componentItem.parent === null) {
            // Note that _contentItem will have dummy GroundItem as parent if initiated by a external drag source
            throw new UnexpectedNullError('DPC10097');
        }

        this._componentItemFocused = this._componentItem.focused;
        if (this._componentItemFocused) {
            this._componentItem.blur();
        }

        if (this._componentItem.parent.contentItems.includes(this._componentItem)) {
            this._componentItem.parent.removeChild(this._componentItem, true);
        }

        this.setDimensions();

        document.body.appendChild(this._element);

        this.determineMinMaxXY();
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

        const stack = this._originalStack ?? this._action.parent?.proxy?._originalStack ?? null;
        if (stack !== null && stack.headerShow) {
            this._sided = stack.headerLeftRightSided;
            this._element.classList.add('lm_' + stack.headerSide);
            if ([Side.right, Side.bottom].indexOf(stack.headerSide) >= 0) {
                this._proxyContainerElement.insertAdjacentElement('afterend', headerElement);
            }
        }
        
        this._element.style.left = numberToPixels(initialX);
        this._element.style.top = numberToPixels(initialY);
        tabElement.setAttribute('title', this._componentItem.title);
        titleElement.insertAdjacentText('afterbegin', this._componentItem.title);
        this._proxyContainerElement.appendChild(this._componentItem.element);
    }

    private determineMinMaxXY(): void {
        const groundItem = this.layoutManager.groundItem;
        if (groundItem === undefined) {
            throw new UnexpectedUndefinedError('DPDMMXY73109');
        } else {
            const groundElement = groundItem.element;
            const rect = groundElement.getBoundingClientRect();
            this._minX = rect.left + document.body.scrollLeft;
            this._minY = rect.top + document.body.scrollTop;
            this._maxX = this._minX + rect.width;
            this._maxY = this._minY + rect.height;
        }
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
        if (this.layoutManager.layoutConfig.settings.constrainDragToContainer) {
            if (x <= this._minX) {
                x = Math.ceil(this._minX);
            } else if (x >= this._maxX) {
                x = Math.floor(this._maxX);
            }

            if (y <= this._minY) {
                y = Math.ceil(this._minY);
            } else if (y >= this._maxY) {
                y = Math.floor(this._maxY);
            }
        }

        this._element.style.left = numberToPixels(x);
        this._element.style.top = numberToPixels(y);
        return this.layoutManager.getArea(x, y);
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

            this.layoutManager.createPopoutFromContentItem(this._componentItem, window, getUniqueId(), undefined);
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
