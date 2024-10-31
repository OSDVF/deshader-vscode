import { BaseLanguageClient, LanguageClientOptions, MessageTransports, AbstractMessageReader, AbstractMessageWriter, DataCallback, Disposable } from 'vscode-languageclient';

export function deshaderLanguageClient(endpoint: string): WebsocketLanguageClient {
    const lsp_ws = new WebSocket(endpoint);
    const client = new WebsocketLanguageClient("deshader-glsl-analyzer", "GLSL Analyzer", {
        documentSelector: [{ scheme: 'deshader', language: 'glsl' }, { scheme: 'file', language: 'glsl' }],
    }, {
        ws: lsp_ws,
        endpoint: endpoint
    }
    );

    client.start();
    return client;
}

/**
 * Handles re-creation of the socet connection when it is closed
 */
interface WebSocketContainer {
	ws: WebSocket
	endpoint: string
}

class WebsocketLanguageClient extends BaseLanguageClient {
	ws: WebSocketContainer;

	constructor(id: string, name: string, clientOptions: LanguageClientOptions, ws: WebSocketContainer) {
		super(id, name, clientOptions);
		this.ws = ws;
	}

	protected createMessageTransports(encoding: string): Promise<MessageTransports> {

		return Promise.resolve({
			reader: new WSMessageReader(this.ws),
			writer: new WSMessageWriter(this.ws)
		});
	}

	dispose(timeout?: number | undefined): Promise<void> {
		this.ws.ws.close();
		return super.dispose(timeout);
	}
}

class WSMessageReader extends AbstractMessageReader {
	ws: WebSocketContainer;

	constructor(ws: WebSocketContainer) {
		super();
		this.ws = ws;
	}

	listen(callback: DataCallback): Disposable {
		const listener = (event: MessageEvent) => {
			callback(JSON.parse(event.data));
		};
		this.ws.ws.addEventListener('message', listener);
		return {
			dispose: () => {
				this.ws.ws.removeEventListener('message', listener);
			}
		};
	}
}

class WSMessageWriter extends AbstractMessageWriter {
	ws: WebSocketContainer;

	constructor(ws: WebSocketContainer) {
		super();
		this.ws = ws;
	}

	async write(msg: any): Promise<void> {
		switch (this.ws.ws.readyState) {
			case WebSocket.CLOSED:
			// @ts-expect-error
			case WebSocket.CLOSING:
				this.ws.ws = new WebSocket(this.ws.endpoint);
			case WebSocket.CONNECTING:
				await new Promise<void>((resolve, reject) => {
					const listenerResolve = () => {
						this.ws.ws.removeEventListener('open', listenerResolve);
						resolve();
					};
					const listenerReject = () => {
						this.ws.ws.removeEventListener('error', listenerReject);
						reject(new Error("Failed to open WebSocket"));
					};
					this.ws.ws.addEventListener('open', listenerResolve);
					this.ws.ws.addEventListener('error', listenerReject);
				});
		}

		this.ws.ws.send(JSON.stringify(msg));
	}
	end() {}
}