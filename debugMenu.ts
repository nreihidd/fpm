let getEditorSymbol = Symbol("debugEditor");
let getEditorFieldOverrideSymbol = Symbol("debugEditorFieldOverride");

export function getEditor(v: any, read: () => any, write: (val: any) => void): HTMLElement {
    if (v === null) {
        return mk('div', {style: "color: grey"}, [text("null")]);
    }
    if (v === undefined) {
        return mk('div', {style: "color: grey"}, [text("undefined")]);
    }
    let ed = v[getEditorSymbol];
    if (ed == null) {
        return mk('div', {style: "color: red"}, [text("uneditable")]);
    } else {
        return ed(read, write);
    }
}
export function getOverrideEditor(v: any, field: string, read: () => any, write: (val: any) => void): HTMLElement {
    let overrides = v[getEditorFieldOverrideSymbol];
    if (overrides != null) {
        let override = overrides[field];
        if (override != null) {
            return override(read, write);
        }
    }
    return getEditor(v[field], read, write);
}

export type getEditorProp = (read: () => any, write: (val: any) => void) => HTMLElement;

export function mk(tag: string, attrs: {[name: string]: any} = {}, children: Node[] = []): HTMLElement {
    let elem = document.createElement(tag);
    for (let attrname in attrs) {
        elem.setAttribute(attrname, attrs[attrname]);
    }
    for (let child of children) {
        elem.appendChild(child);
    }
    return elem;
}
export function text(s: string): Node {
    return document.createTextNode(s);
}
export function listen(el: HTMLElement, eventMap: {[name: string]: any}): HTMLElement {
    for (let name in eventMap) {
        el.addEventListener(name, eventMap[name]);
    }
    return el;
}

export function defineEditor<T>(prototype: any, editor: getEditorProp) {
    Object.defineProperty(prototype, getEditorSymbol, {
        enumerable: false,
        configurable: false,
        writable: false,
        value: editor
    });
}
export function defineOverrideEditor<T>(obj: Object, field: string, editor: getEditorProp) {
    if (!obj.hasOwnProperty(getEditorFieldOverrideSymbol)) {
        Object.defineProperty(obj, getEditorFieldOverrideSymbol, {
            enumerable: false,
            configurable: false,
            writable: false,
            value: {}
        });
    }
    let overrides: {[prop: string]: getEditorProp} = (obj as any)[getEditorFieldOverrideSymbol];
    overrides[field] = editor;
}

function flatMap<T, R>(iterable: Iterable<T>, f: (t: T) => Iterable<R>): R[] {
    let rs = [];
    for (let t of iterable) {
        for (let r of f(t)) {
            rs.push(r);
        }
    }
    return rs;
}

function maybeProp(obj: any, prop: string): any {
    if (obj == null) return undefined;
    return obj[prop];
}

let nameOverrides = new Map<any, string>();
for (let name in THREE) {
    let entry = (THREE as any)[name];
    let constructorName = maybeProp(entry, "name");
    if (constructorName != null) {
        nameOverrides.set(entry, name);
    }
}

function getPrototypeName(proto: any): string|undefined {
    let constructor = maybeProp(proto, "constructor");
    let name = maybeProp(constructor, "name");
    if (name != null) {
        let override = nameOverrides.get(constructor);
        if (override != null) {
            return override;
        } else {
            return name;
        }
    }
    return undefined;
}

defineEditor(Object.prototype, (read, write) => {
    let collapseText: string;
    let expandText: string;
    {
        let protoName = getPrototypeName(Object.getPrototypeOf(read()));
        if (protoName != null) {
            collapseText = "-" + protoName;
            expandText = "+" + protoName;
        } else {
            collapseText = "-Object";
            expandText = "+Object";
        }
    }
    let collapseLabel = mk('span', {style: "color: #ff00ff; cursor: pointer"}, [text(expandText)]);
    let root = mk('div', {}, [collapseLabel]);
    let child: HTMLElement|null = null;
    listen(collapseLabel, {
        click() {
            if (child == null) {
                child = mk('div', {style: "display: grid; grid-template-columns: auto auto;"},
                    flatMap(Object.keys(read()), key => [
                        mk('div', {style: "padding-right: 2px"}, [text(key)]),
                        getOverrideEditor(read(), key, () => read()[key], (v) => read()[key] = v)
                    ])
                );
                root.appendChild(child);
                collapseLabel.textContent = collapseText;
            } else {
                root.removeChild(child);
                child = null;
                collapseLabel.textContent = expandText;
            }
        }
    });
    return root;
});
defineEditor(Number.prototype, (read, write) => {
    let input = mk('input', {type: 'text', value: read(), style: "background: rgba(0, 0, 255, 0.2)"}, []) as HTMLInputElement;
    let focused = false;
    return listen(input, {
        change() {
            write(parseFloat(input.value));
        },
        keydown(evt: any) {
            if (evt.keyCode === 13) {
                write(parseFloat(input.value));
            }
        }
    });
});
defineEditor(Boolean.prototype, (read, write) => {
    let input = mk('span', {style: 'cursor: pointer;'}, []);
    let checked = read();
    function updateStyle() {
        input.style.color = checked ? "#00ff00" : "#ff0000";
        input.textContent = checked ? "True" : "False";
    }
    updateStyle();
    return listen(input, {
        click() {
            checked = !checked;
            updateStyle();
            write(checked)
        }
    });
});
defineEditor(String.prototype, (read, write) => {
    let input = mk('input', {type: 'text'}, []) as HTMLInputElement;
    input.value = read();
    return listen(input, {
        change() {
            write(input.value)
        },
        keydown(evt: any) {
            if (evt.keyCode === 13 && !evt.ctrlKey) {
                evt.stopPropagation();
                evt.preventDefault();
                write(input.value);
            }
        }
    });
});
defineEditor(Function.prototype, (read, write) => {
    let callable = read().length === 0;
    if (callable) {
        let input = mk('span', {style: 'cursor: pointer; color: cyan;'}, [text("Call")]);
        listen(input, {
            click() {
                read()();
            }
        });
        return input;
    } else {
        return mk('span', {style: 'color: grey;'}, [text("Function")]);
    }
});

export function clampedEditor(min: number, max: number): getEditorProp {
    function clamp(val: number, min: number, max: number) {
        return Math.min(Math.max(val, min), max);
    }
    return (read, write) => {
        let input = mk('input', {type: 'range', min, max, step: 'any'}) as HTMLInputElement;
        input.value = read();
        let focused = false;
        let held = false;
        function update() {
            setTimeout(() => {
                write(clamp(input.valueAsNumber, min, max))
                if (held) {
                    update();
                }
            }, 30);
        }
        listen(input, {
            mousedown() {
                held = true;
                update();
            },
            mouseup() {
                held = false;
            },
            blur() {
                held = false;
            },
            change() {
                write(clamp(input.valueAsNumber, min, max));
            }
        });
        return input;
    }
}

let editorRoot = document.querySelector("#debug-editor")!;
let currentEditor: HTMLElement|null = null;
export function setEditor(mutable: any) {
    if (currentEditor != null) {
        editorRoot.removeChild(currentEditor);
        currentEditor = null;
    }
    currentEditor = getEditor(mutable, () => mutable, (v: any) => mutable = v);
    editorRoot.appendChild(currentEditor);
}