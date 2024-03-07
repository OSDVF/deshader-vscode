import { MapLike } from 'typescript';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';

export const Events = {
    connected: Symbol(),
    message: Symbol(),
    error: Symbol(),
    close: Symbol(),
    stopOnEntry: Symbol(),
    stopOnStep: Symbol(),
    stopOnBreakpoint: Symbol(),
    stopOnDataBreakpoint: Symbol(),
    stopOnFunction: Symbol(),
    breakpointValidated: Symbol(),
    output: Symbol(),
    end: Symbol()
};
export type EventArgs = {
    connected: [],
    message: [String],
    error: [Event],
    close: [CloseEvent],
    stopOnEntry: [number],
    stopOnStep: [number],
    stopOnBreakpoint: [number],
    stopOnDataBreakpoint: [number],
    stopOnFunction: [String],
    breakpointValidated: [DebugProtocol.Breakpoint],
    output: ["prio" | "out" | "err", DebugProtocol.OutputEvent['body']['group'], string, number, number]
    end: []
}
export type Config = { protocol: "ws" | "wss" | "http" | "https", address: string, port: number };
export type WithLength<T> = T & { length?: number };
/**
 * Communicates through WS or HTTP with a running Deshader instance
 * Proxies both the virtual file system and the debugger
 */
export abstract class Communicator extends EventEmitter {
    uri: vscode.Uri;
    output: vscode.OutputChannel;
    connected: Promise<void>;
    protected _resolveConnected!: () => void;
    protected _rejectConnected!: () => void;

    constructor(uri: vscode.Uri, output: vscode.OutputChannel, open = true) {
        super();
        this.uri = uri;
        this.output = output;
        this.connected = new Promise((resolve, reject) => {
            this._resolveConnected = resolve;
            this._rejectConnected = reject;
        })
        if (open) {
            this.open();
        }
    }

    on<T extends keyof typeof Events>(eventName: (typeof Events)[T], listener: (...args: EventArgs[T]) => void): this {
        return super.on(eventName, listener as any);
    }
    once<T extends keyof typeof Events>(eventName: (typeof Events)[T], listener: (...args: EventArgs[T]) => void): this {
        return super.once(eventName, listener as any);
    }
    emit<T extends keyof typeof Events>(eventName: (typeof Events)[T], ...args: EventArgs[T]): boolean {
        return super.emit(eventName, ...args);
    }

    static fromUri(uri: vscode.Uri, output: vscode.OutputChannel, open = true): Communicator {
        switch (uri.scheme) {
            case 'ws':
                return new WSCommunicator(uri, output, open);
            default:
                throw new Error(`Unknown scheme ${uri.scheme}`);
        }
    }

    static fromConfig(config: Config, output: vscode.OutputChannel, open = true) {
        switch (config.protocol) {
            case "ws":
            case "wss":
                return new WSCommunicator(vscode.Uri.from({
                    scheme: config.protocol,
                    authority: `${config.address}:${config.port}`
                }), output, open);
            default:
                throw new Error(`Unknown protocol ${config.protocol}`);
        }
    }

    abstract dispose(): void;
    abstract open(): void;

    abstract send(command: string, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string>;
    abstract sendParametric(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string>;
    abstract sendParametricJson<T>(command: string, params: MapLike<string | number | boolean | null | undefined> | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<T>;

    statSource(path: string): Promise<vscode.FileStat> {
        return this.sendParametricJson<vscode.FileStat>("statSource", { path });
    }

    statProgram(path: string): Promise<vscode.FileStat> {
        return this.sendParametricJson<vscode.FileStat>("statProgram", { path });
    }

    stat(path: string): Promise<vscode.FileStat> {
        return this.sendParametricJson<vscode.FileStat>("stat", { path });
    }

    getVersion(): Promise<string> {
        return this.send('version');
    }
    async listSources(path?: string, recursive = false, untagged = false): Promise<string[]> {
        const sources = await this.sendParametric('listSources', typeof path == "undefined" ? { recursive, untagged } : { path, recursive, untagged });
        return sources.splitNoOrphans('\n');
    }
    async listPrograms(path?: string, recursive = false, untagged = false): Promise<string[]> {
        const programs = await this.sendParametric('listPrograms', typeof path == "undefined" ? { recursive, untagged } : { path, recursive, untagged });
        return programs.splitNoOrphans('\n');
    }
    async listWorkspace(path?: string, recursive = false, untagged = false): Promise<string[]> {
        const workspace = await this.sendParametric('listWorkspace', typeof path == "undefined" ? { recursive, untagged } : { path, recursive, untagged });
        return workspace.splitNoOrphans('\n');
    }
    async readFile(path: string): Promise<string> {
        return await this.sendParametric('readFile', { path });
    }

    setFunctionBreakpoint(breakpoint: DebugProtocol.FunctionBreakpoint): Promise<DebugProtocol.Breakpoint> {
        return this.sendParametricJson<DebugProtocol.Breakpoint>('setFunctionBreakpoint', breakpoint);
    }
    setBreakpoint(path: string, line: number, column: number): Promise<DebugProtocol.Breakpoint> {
        return this.sendParametricJson<DebugProtocol.Breakpoint>('setBreakpoint', { path, line, column });
    }
    async clearBreakpoints(path: string): Promise<void> {
        await this.sendParametric('clearBreakpoints', { path });
    }
    getBreakpoints(args: DebugProtocol.BreakpointLocationsArguments): Promise<DebugProtocol.BreakpointLocation[]> {
        return this.sendParametricJson<DebugProtocol.BreakpointLocation[]>('getBreakpoints', args);
    }
    stackTrace(args: DebugProtocol.StackTraceArguments): Promise<DebugProtocol.StackFrame[]> {
        return this.sendParametricJson<DebugProtocol.StackFrame[]>('stackTrace', args);
    }
    writeMemory(request: DebugProtocol.WriteMemoryArguments): Promise<DebugProtocol.WriteMemoryResponse['body']> {
        return this.sendParametricJson<DebugProtocol.WriteMemoryResponse['body']>('writeMemory', request);
    }
    readMemory(request: DebugProtocol.ReadMemoryArguments): Promise<DebugProtocol.ReadMemoryResponse['body']> {
        return this.sendParametricJson<DebugProtocol.ReadMemoryResponse['body']>('readMemory', request);
    }
    variables(args: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]> {
        return this.sendParametricJson<DebugProtocol.Variable[]>('variables', args);
    }
    setVariable(args: DebugProtocol.SetVariableArguments): Promise<WithLength<DebugProtocol.SetVariableResponse['body']>> {
        return this.sendParametricJson<WithLength<DebugProtocol.SetVariableResponse['body']>>('setVariable', args);
    }
    scopes(args: DebugProtocol.ScopesArguments): Promise<DebugProtocol.Scope[]> {
        return this.sendParametricJson<DebugProtocol.Scope[]>('scopes', args);
    }
    async continue(): Promise<void> {
        await this.send('continue');
    }
    getStepInTargets(frameId: number): Promise<DebugProtocol.StepInTarget[]> {
        return this.sendParametricJson<DebugProtocol.StepInTarget[]>('getStepInTargets', { frameId });
    }
    async stepLine(threadId?: number | undefined): Promise<void> {
        await this.sendParametric('stepLine', { threadId });
    }
    async stepStatement(threadId?: number | undefined): Promise<void> {
        await this.sendParametric('stepStatement', { threadId });
    }
    async stepIn(args: DebugProtocol.StepInArguments): Promise<void> {
        await this.sendParametric('stepIn', args);
    }
    async stepOut(args: DebugProtocol.StepOutArguments): Promise<void> {
        await this.sendParametric('stepOut', args);
    }
    evaluate(args: DebugProtocol.EvaluateArguments): Promise<WithLength<DebugProtocol.EvaluateResponse['body']>> {
        return this.sendParametricJson<WithLength<DebugProtocol.EvaluateResponse['body']>>('evaluate', args);
    }
    setExpression(args: DebugProtocol.SetExpressionArguments): Promise<WithLength<DebugProtocol.SetExpressionResponse['body']>> {
        return this.sendParametricJson<WithLength<DebugProtocol.SetExpressionResponse['body']>>('setExpression', args);
    }
    dataBreakpointInfo(args: DebugProtocol.DataBreakpointInfoArguments): Promise<DebugProtocol.DataBreakpointInfoResponse['body']> {
        return this.sendParametricJson<DebugProtocol.DataBreakpointInfoResponse['body']>('dataBreakpointInfo', args);
    }
    async clearAllDataBreakpoints(): Promise<void> {
        await this.send('clearAllDataBreakpoints');
    }
    setDataBreakpoint(args: DebugProtocol.DataBreakpoint): Promise<DebugProtocol.Breakpoint> {
        return this.sendParametricJson<DebugProtocol.Breakpoint>('setDataBreakpoint', args);
    }
    completion(args: DebugProtocol.CompletionsArguments): Promise<DebugProtocol.CompletionItem[]> {
        return this.sendParametricJson<DebugProtocol.CompletionItem[]>('completion', args);
    }
    async cancel(args: DebugProtocol.CancelArguments): Promise<void> {
        await this.sendParametric('cancel', args);
    }
}

declare global {
    interface String {
        splitNoOrphans(separator: string | RegExp, limit?: number): string[];
    }
}

String.prototype.splitNoOrphans = function (separator: string | RegExp, limit?: number): string[] {
    const arr = this.split(separator, limit);
    if (arr[arr.length - 1] === '') {
        arr.pop();
    }
    return arr;
}

export class WSCommunicator extends Communicator implements vscode.Disposable {
    ws!: WebSocket;
    pendingRequests: MapLike<{
        promise: Promise<any> | null,
        resolve: (response: Blob) => void
        reject: (response: Blob) => void
    }> = {};

    constructor(uri: vscode.Uri, output: vscode.OutputChannel, open = true) {
        super(uri, output, open);
    }

    open() {
        this.ws = new WebSocket(this.uri.toString());
        this.ws.onopen = () => {
            this.output.appendLine('WebSocket connection established');
            this.emit(Events.connected);
            this._resolveConnected();
        };
        this.ws.addEventListener('message', (event) => {
            this.output.appendLine(event.data);

            for (let [command, actions] of Object.entries(this.pendingRequests)) {
                const responseLines: string[] = event.data.split('\n');//0: status, 1: echoed command, 2: body
                if (responseLines.length > 1 &&
                    responseLines[1].startsWith(command)) {
                    const resp = responseLines.slice(2).join('\n');
                    this.emit(Events.message, resp);
                    if (responseLines[0].startsWith('202')) {
                        actions.resolve(new Blob([resp]));
                    } else {
                        actions.reject(new Blob([resp]));
                    }
                }
            }
        });
        this.ws.addEventListener('error', (event) => {
            this.output.appendLine("WebSocket connection has been closed by an error");
            this.emit(Events.error, event)
            this._rejectConnected();
        })
        this.ws.addEventListener('close', (event) => {
            this.output.appendLine("WebSocket connection has been closed " + (event.wasClean ? "clean" : "unclean") + " with reason (" + event.code + "): " + event.reason);
            this.emit(Events.close, event)
            this._rejectConnected();
        })
    }

    sendParametricJson<T>(command: string, params?: MapLike<string | number | boolean | null | undefined> | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<T> {
        const str = this.sendParametric(command, params, body);
        return str.then((response) => JSON.parse(response) as T);
    }

    sendParametric(command: string, params?: { [key: string]: string | number | boolean | null | undefined } | object, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string> {
        let i = 0;
        if (typeof params !== 'undefined') {
            for (let [key, value] of Object.entries(params)) {
                if (i++ == 0) {
                    command += '?';
                } else {
                    command += '&';
                }
                command += encodeURIComponent(key);
                if (typeof value !== 'undefined') {
                    command += '=' + encodeURIComponent(value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value));
                }
            }
        }
        return this.send(command, body);
    }

    send(command: string, body?: string | ArrayBufferLike | Blob | ArrayBufferView): Promise<string> {
        if (typeof this.pendingRequests[command] === 'undefined') {
            const p = new Promise<string>((_resolve, _reject) => {
                const t = setTimeout(() => {
                    _reject(new Error('Request timed out'));
                    delete this.pendingRequests[command];
                }, 5000);//TODO put timeout in config
                this.pendingRequests[command] = {
                    promise: null,
                    resolve(response) {
                        clearTimeout(t)
                        _resolve(response.text())
                    },
                    async reject(response) {
                        clearTimeout(t)
                        _reject(new Error(await response.text()))
                    }
                };
            });
            this.pendingRequests[command].promise = p;
            this.ws.send(new Blob([command, ...body ? [body] : []]));
            return p;
        } else {
            return this.pendingRequests[command].promise as Promise<string>;
        }
    }

    dispose() {
        this.ws.close();
    }
}