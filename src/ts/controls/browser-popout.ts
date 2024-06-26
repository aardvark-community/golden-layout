import { ResolvedLayoutConfig, ResolvedPopoutLayoutConfig, ResolvedRowOrColumnItemConfig } from '../config/resolved-config';
import { PopoutBlockedError } from '../errors/external-error';
import { UnexpectedNullError, UnexpectedUndefinedError } from '../errors/internal-error';
import { ContentItem } from '../items/content-item';
import { RowOrColumn } from '../items/row-or-column';
import { LayoutManager } from '../layout-manager';
import { EventEmitter } from '../utils/event-emitter';
import { Rect, ItemType } from '../utils/types';
import { deepExtend, getErrorMessage, getUniqueId, getWindowTopLeftBorder } from '../utils/utils';

/**
 * Pops a content item out into a new browser window.
 * This is achieved by
 *
 *    - Creating a new configuration with the content item as root element
 *    - Serializing and minifying the configuration
 *    - Opening the current window's URL with the configuration as a GET parameter
 *    - GoldenLayout when opened in the new window will look for the GET parameter
 *      and use it instead of the provided configuration
 * @public
 */

export class BrowserPopout extends EventEmitter {
    /** @internal */
    private _popoutWindow: Window | null;
    /** @internal */
    private _isInitialised: boolean;
    /** @internal */
    private _checkReadyInterval: ReturnType<typeof setTimeout> | undefined;
    /** @internal */
    private _preventPopInOnClose: boolean;

    get isInitialised(): boolean { return this._isInitialised; }

    /**
     * @param _config - GoldenLayout item config
     * @param _initialWindowSize - A map with width, height, top and left
     * @internal
     */
    constructor(
        /** @internal */
        private _config: ResolvedPopoutLayoutConfig,
        /** @internal */
        private _initialWindowSize: Rect,
        /** @internal */
        private _layoutManager: LayoutManager,
    ) {
        super();

        this._isInitialised = false;
        this._popoutWindow = null;
        this._preventPopInOnClose = false;
        this.createWindow();
    }

    toConfig(): ResolvedPopoutLayoutConfig {
        if (this._isInitialised === false) {
            throw new Error('Can\'t create config, layout not yet initialised');
        }

        const glInstance = this.getGlInstance();
        const glInstanceConfig = glInstance.saveLayout();

        let left: number | null;
        let top: number | null;
        if (this._popoutWindow === null) {
            left = null;
            top = null;
        } else {
            left = this._popoutWindow.screenX ?? this._popoutWindow.screenLeft;
            top = this._popoutWindow.screenY ?? this._popoutWindow.screenTop;
        }

        const window: ResolvedPopoutLayoutConfig.Window = {
            width: this.getGlInstance().width,
            height: this.getGlInstance().height,
            left,
            top,
        };

        const config: ResolvedPopoutLayoutConfig = {
            root: glInstanceConfig.root,
            openPopouts: glInstanceConfig.openPopouts,
            settings: glInstanceConfig.settings,
            dimensions: glInstanceConfig.dimensions,
            header: glInstanceConfig.header,
            window,
            parentId: this._config.parentId,
            indexInParent: this._config.indexInParent,
            resolved: true,
        };

        return config;
    }

    getGlInstance(): LayoutManager {
        if (this._popoutWindow === null) {
            throw new UnexpectedNullError('BPGGI24693');
        }
        return this._popoutWindow.__glInstance;
    }

    /**
     * Retrieves the native BrowserWindow backing this popout.
     * Might throw an UnexpectedNullError exception when the window is not initialized yet.
     * @public
     */
    getWindow(): Window {
        if (this._popoutWindow === null) {
            throw new UnexpectedNullError('BPGW087215');
        }
        return this._popoutWindow;
    }

    close(preventPopIn = false): void {
        if (preventPopIn) {
            this._preventPopInOnClose = true;
        }

        if (this.getGlInstance()) {
            this.getGlInstance().closeWindow();
        } else {
            try {
                this.getWindow().close();
            } catch (e) {
                //
            }
        }
    }

    /**
     * Returns the popped out item to its original position. If the original
     * parent isn't available anymore it falls back to the layout's topmost element
     */
    popIn(): void {
        let parentItem: ContentItem | null = null;
        let index = this._config.indexInParent;

        /*
        * The deepExtend call seems a bit pointless, but it's crucial to
        * copy the config returned by this.getGlInstance().toConfig()
        * onto a new object. Internet Explorer keeps the references
        * to objects on the child window, resulting in the following error
        * once the child window is closed:
        *
        * The callee (server [not server application]) is not available and disappeared
        */
        const glInstanceLayoutConfig = this.getGlInstance().saveLayout();
        const copiedGlInstanceLayoutConfig = deepExtend({}, glInstanceLayoutConfig) as ResolvedLayoutConfig;
        let copiedRoot = copiedGlInstanceLayoutConfig.root;
        if (copiedRoot === undefined) {
            return;
        }
        const groundItem = this._layoutManager.groundItem;
        if (groundItem === undefined) {
            throw new UnexpectedUndefinedError('BPPIG34972');
        }

        if (this._config.parentId) {    
            parentItem = groundItem.getItemsByPopInParentId(this._config.parentId)[0];
        }

        /*
        * Fallback if parentItem is not available. Either add it to the topmost
        * item or make it the topmost item if the layout is empty
        */
        if (!parentItem) {
            if (groundItem.contentItems.length > 0) {
                parentItem = groundItem.contentItems[0];
            } else {
                parentItem = groundItem;
            }
            index = parentItem.contentItems.length;
        }

        if (parentItem.isStack) {   
            // Stacks can only hold component items -> try to find one by unraveling containers with a single child
            while (copiedRoot.type !== ItemType.component && copiedRoot.content.length === 1) {
                copiedRoot = copiedRoot.content[0];
            }

            // Failed to find a component item, wrap the parent item and docked item in a row as siblings
            if (copiedRoot.type !== ItemType.component) {
                if (parentItem.parent === null) {
                    throw new UnexpectedNullError('BPPIG34973');
                }

                const row = new RowOrColumn(false, this._layoutManager, ResolvedRowOrColumnItemConfig.createDefault('row'), parentItem.parent);
                parentItem.parent.replaceChild(parentItem, row, false);
                row.addChild(parentItem);
                parentItem = row;
                index = 1;
            }
        }

        const newContentItem = this._layoutManager.createAndInitContentItem(copiedRoot, parentItem);

        index = (index !== null) ? Math.max(0, Math.min(parentItem.contentItems.length, index)) : null;
        parentItem.addChild(newContentItem, index);
        if (this._layoutManager.layoutConfig.settings.popInOnClose) {
            this._onClose();
        } else {
            this.close();
        }
    }

    /**
     * Creates the URL and window parameter
     * and opens a new window
     * @internal
     */
    private createWindow(): void {
        const url = this.createUrl();

        /**
         * Bogus title to prevent re-usage of existing window with the
         * same title. The actual title will be set by the new window's
         * GoldenLayout instance if it detects that it is in subWindowMode
         */
        const target = Math.floor(Math.random() * 1000000).toString(36);

        /**
         * The options as used in the window.open string
         */
        const features = this.serializeWindowFeatures({
            left: this._initialWindowSize.left,
            top: this._initialWindowSize.top,
            width: this._initialWindowSize.width,
            height: this._initialWindowSize.height,
            innerWidth: this._initialWindowSize.width,
            innerHeight: this._initialWindowSize.height,
            menubar: 'no',
            toolbar: 'no',
            location: 'no',
            personalbar: 'no',
            resizable: 'yes',
            scrollbars: 'no',
            status: 'no'
        });

        this._popoutWindow = globalThis.open(url, target, features);

        if (!this._popoutWindow) {
            if (this._layoutManager.layoutConfig.settings.blockedPopoutsThrowError === true) {
                const error = new PopoutBlockedError('Popout blocked');
                throw error;
            } else {
                return;
            }
        }

        this._popoutWindow.addEventListener('load', () => {    
            this.positionAndResizeWindow();
            
            if (this._popoutWindow) {
                this._popoutWindow.addEventListener('beforeunload', () => {
                    if (this._layoutManager.layoutConfig.settings.popInOnClose && !this._preventPopInOnClose) {
                        this.popIn();
                    } else {
                        this._onClose();
                    }
                }, { passive: true });
            }
        }, { passive: true });

        /**
         * Polling the childwindow to find out if GoldenLayout has been initialised
         * doesn't seem optimal, but the alternatives - adding a callback to the parent
         * window or raising an event on the window object - both would introduce knowledge
         * about the parent to the child window which we'd rather avoid
         */
        this._checkReadyInterval = setInterval(() => this.checkReady(), 10);
    }

    /** @internal */
    private checkReady() {
        if (this._popoutWindow === null) {
            throw new UnexpectedNullError('BPCR01844');
        } else {
            if (this._popoutWindow.__glInstance && this._popoutWindow.__glInstance.isInitialised) {
                this._popoutWindow.__glInstance.parent = this._layoutManager;
                this.onInitialised();
                if (this._checkReadyInterval !== undefined) {
                    clearInterval(this._checkReadyInterval);
                    this._checkReadyInterval = undefined;
                }
            }
        }
    }

    /**
     * @internal
     */
    private positionAndResizeWindow() {
        if (this._popoutWindow === null) {
            throw new UnexpectedNullError('BPPARW1');
        }

        // Initial window size parameters describe client (i.e. inner) position and size
        // Since the border of the popout may have different borders than the main window, we have
        // to adjust the position and size once the window has been created.
        // Only do this if the window parameters are plausible (e.g. on Linux inner dimension is zero sometimes)
        if (this._popoutWindow.innerWidth > 0 && this._popoutWindow.innerHeight > 0 &&
            this._popoutWindow.outerWidth > 0 && this._popoutWindow.outerHeight > 0 &&
            this._popoutWindow.innerWidth <= this._popoutWindow.outerWidth &&
            this._popoutWindow.innerHeight <= this._popoutWindow.outerHeight) {
                
            const border = getWindowTopLeftBorder(this._popoutWindow);
            this._popoutWindow.moveTo(
                this._initialWindowSize.left - border.width,
                this._initialWindowSize.top - border.height,
            )
            
            this._popoutWindow.resizeTo(
                this._initialWindowSize.width + (this._popoutWindow.outerWidth - this._popoutWindow.innerWidth),
                this._initialWindowSize.height + (this._popoutWindow.outerHeight - this._popoutWindow.innerHeight)
            );
        }

        this._popoutWindow.focus();
    }

    /**
     * Serialises a map of key:values to a window options string
     *
     * @param windowOptions -
     *
     * @returns serialised window options
     * @internal
     */
    private serializeWindowFeatures(windowOptions: Record<string, string | number>): string {
        const windowOptionsString: string[] = [];

        for (const key in windowOptions) {
            windowOptionsString.push(key + '=' + windowOptions[key].toString());
        }

        return windowOptionsString.join(',');
    }

    /**
     * Creates the URL for the new window, including the
     * config GET parameter
     *
     * @returns URL
     * @internal
     */
    private createUrl(): string {
        const storageKey = 'gl-window-config-' + getUniqueId();
        const config = ResolvedLayoutConfig.minifyConfig(this._config);

        try {
            localStorage.setItem(storageKey, JSON.stringify(config));
        } catch (e) {
            throw new Error('Error while writing to localStorage ' + getErrorMessage(e));
        }

        const url = new URL('/gl-popout', location.origin);
        url.searchParams.set('gl-window', storageKey);

        const theme = this._layoutManager.container.dataset.theme;
        if (theme !== undefined) {
            url.searchParams.set('gl-theme', theme);
        }

        return url.toString();
    }

    /**
     * Callback when the new window is opened and the GoldenLayout instance
     * within it is initialised
     * @internal
     */
    private onInitialised(): void {
        this._isInitialised = true;
        this.getGlInstance().on('popIn', () => this.popIn());
        this.emit('initialised');
    }

    /**
     * Invoked 50ms after the window unload event
     * @internal
     */
    private _onClose() {
        setTimeout(() => this.emit('closed'), 50);
    }
}
