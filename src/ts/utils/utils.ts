import { LeftAndTop, WidthAndHeight } from './types';

/** @internal */
export function numberToPixels(value: number): string {
    return value.toString(10) + 'px';
}

/** @internal */
export function pixelsToNumber(value: string): number {
    const numberStr = value.replace("px", "");
    return parseFloat(numberStr);
}

/** @internal */
export interface SplitStringAtFirstNonNumericCharResult {
    numericPart: string;
    firstNonNumericCharPart: string;
}

/** @internal */
export function splitStringAtFirstNonNumericChar(value: string): SplitStringAtFirstNonNumericCharResult {
    value = value.trimStart();

    const length = value.length;
    if (length === 0) {
        return { numericPart: '', firstNonNumericCharPart: '' }
    } else {
        let firstNonDigitPartIndex = length;
        let gotDecimalPoint = false;
        for (let i = 0; i < length; i++) {
            const char = value[i];
            if (!isDigit(char)) {
                if (char !== '.') {
                    firstNonDigitPartIndex = i;
                    break;
                } else {
                    if (gotDecimalPoint) {
                        firstNonDigitPartIndex = i;
                        break;
                    } else {
                        gotDecimalPoint = true;
                    }
                }
            }
        }
        const digitsPart = value.substring(0, firstNonDigitPartIndex);
        const firstNonDigitPart = value.substring(firstNonDigitPartIndex).trim();

        return { numericPart: digitsPart, firstNonNumericCharPart: firstNonDigitPart };
    }
}

/** @internal */
export function isDigit(char: string) {
    return char >= '0' && char <= '9';
}

/** @internal */
export function getElementWidth(element: HTMLElement): number {
    return element.offsetWidth;
}

/** @internal */
export function setElementWidth(element: HTMLElement, width: number): void {
    const widthAsPixels = numberToPixels(Math.max(0, width));
    element.style.width = widthAsPixels;
}

/** @internal */
export function getElementHeight(element: HTMLElement): number {
    return element.offsetHeight;
}

/** @internal */
export function setElementHeight(element: HTMLElement, height: number): void {
    const heightAsPixels = numberToPixels(Math.max(0, height));
    element.style.height = heightAsPixels;
}

/** @internal */
export function getElementWidthAndHeight(element: HTMLElement): WidthAndHeight {
    return {
        width: element.offsetWidth,
        height: element.offsetHeight,
    };
}

/** @internal */
export function getWindowTopLeftBorder(window: Window | typeof globalThis): WidthAndHeight {
    let innerScreenX: number | undefined = (<any>window).mozInnerScreenX;
    let innerScreenY: number | undefined = (<any>window).mozInnerScreenY;
    let borderX: number, borderY: number;

    if (innerScreenX === undefined || innerScreenY === undefined) {
        borderX = (window.outerWidth - window.innerWidth) / 2;        // Assume left / right border is the same
        borderY = window.outerHeight - window.innerHeight - borderX;  // Assume bottom border is the same as left / right
    } else {
        borderX = innerScreenX - window.screenX;
        borderY = innerScreenY - window.screenY;
    }

    return { width: Math.max(0, borderX), height: Math.max(0, borderY) }
}

/** @internal */
export function getWindowInnerScreenPosition(window: Window | typeof globalThis): LeftAndTop {
    let innerScreenX: number | undefined = (<any>window).mozInnerScreenX;
    let innerScreenY: number | undefined = (<any>window).mozInnerScreenY;

    if (innerScreenX === undefined || innerScreenY === undefined) {
        const border = getWindowTopLeftBorder(window);
        innerScreenX = window.screenX + border.width;
        innerScreenY = window.screenY + border.height;
    }

    return { left: innerScreenX, top: innerScreenY };
}


/** @internal */
export function setElementDisplayVisibility(element: HTMLElement, visible: boolean): void {
    if (visible) {
        element.style.display = '';
    } else {
        element.style.display = 'none';
    }
}

/** @internal */
export function ensureElementPositionAbsolute(element: HTMLElement): void {
    const absolutePosition = 'absolute';
    if (element.style.position !== absolutePosition) {
        element.style.position = absolutePosition;
    }
}

/**
 * Replacement for JQuery $.extend(target, obj)
 * @internal
*/
export function extend(target: Record<string, unknown>, obj: Record<string, unknown>): Record<string, unknown> {
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            target[key] = obj[key];
        }
    }
    return target;
}

/**
 * Replacement for JQuery $.extend(true, target, obj)
 * @internal
*/
export function deepExtend(target: Record<string, unknown>, obj: Record<string, unknown> | undefined): Record<string, unknown> {
    if (obj !== undefined) {
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const value = obj[key];
                const existingTarget = target[key];
                target[key] = deepExtendValue(existingTarget, value);
            }
        }
    }

    return target;
}

/** @internal */
export function deepExtendValue(existingTarget: unknown, value: unknown): unknown {
    if (typeof value !== 'object') {
        return value;
    } else {
        if (Array.isArray(value)) {
            const length = value.length;
            const targetArray = new Array<unknown>(length);
            for (let i = 0; i < length; i++) {
                const element = value[i];
                targetArray[i] = deepExtendValue({}, element);
            }
            return targetArray;
        } else {
            if (value === null) {
                return null;
            } else {
                const valueObj = value as Record<string, unknown>;
                if (existingTarget === undefined) {
                    return deepExtend({}, valueObj); // overwrite
                } else {
                    if (typeof existingTarget !== "object") {
                        return deepExtend({}, valueObj); // overwrite
                    } else {
                        if (Array.isArray(existingTarget)) {
                            return deepExtend({}, valueObj); // overwrite
                        } else {
                            if (existingTarget === null) {
                                return deepExtend({}, valueObj); // overwrite
                            } else {
                                const existingTargetObj = existingTarget as Record<string, unknown>;
                                return deepExtend(existingTargetObj, valueObj); // merge
                            }
                        }
                    }
                }
            }
        }
    }
}

/** @internal */
export function removeFromArray<T>(item: T, array: T[]): void {
    const index = array.indexOf(item);

    if (index === -1) {
        throw new Error('Can\'t remove item from array. Item is not in the array');
    }

    array.splice(index, 1);
}

/** @internal */
export function getUniqueId(): string {
    return (Math.random() * 1000000000000000)
        .toString(36)
        .replace('.', '');
}

/** @internal */
export function getErrorMessage(e: unknown): string {
    if (e instanceof Error) {
        return e.message;
    } else {
        if (typeof e === 'string') {
            return e;
        } else {
            return 'Unknown Error';
        }
    }
}
