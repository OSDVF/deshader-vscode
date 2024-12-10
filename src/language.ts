import { BaseLanguageClient, LanguageClientOptions, MessageTransports, AbstractMessageReader, AbstractMessageWriter, DataCallback, Disposable } from 'vscode-languageclient'
import { WebSocketContainer } from './deshader'

export function deshaderLanguageClient(comm: WebSocketContainer): WebsocketLanguageClient {
	const client = new WebsocketLanguageClient("deshader-glsl-analyzer", "GLSL Analyzer", {
		documentSelector: [{ scheme: 'deshader', language: 'glsl' }, { scheme: 'file', language: 'glsl' }],
	}, comm)

	client.start()
	return client
}

class WebsocketLanguageClient extends BaseLanguageClient {
	ws: WebSocketContainer

	constructor(id: string, name: string, clientOptions: LanguageClientOptions, ws: WebSocketContainer) {
		super(id, name, clientOptions)
		this.ws = ws
	}

	protected createMessageTransports(encoding: string): Promise<MessageTransports> {

		return Promise.resolve({
			reader: new WSMessageReader(this.ws),
			writer: new WSMessageWriter(this.ws)
		})
	}

	dispose(timeout?: number | undefined): Promise<void> {
		this.ws.close()
		return super.dispose(timeout)
	}
}

class WSMessageReader extends AbstractMessageReader {
	ws: WebSocketContainer

	constructor(ws: WebSocketContainer) {
		super()
		this.ws = ws
	}

	listen(callback: DataCallback): Disposable {
		const listener = (event: MessageEvent) => {
			callback(JSON.parse(event.data))
		}
		this.ws.onMessage.add(listener)
		return {
			dispose: () => {
				this.ws.onMessage.delete(listener)
			}
		}
	}
}

class WSMessageWriter extends AbstractMessageWriter {
	ws: WebSocketContainer

	constructor(ws: WebSocketContainer) {
		super()
		this.ws = ws
	}

	async write(msg: any): Promise<void> {
		return this.ws.send(JSON.stringify(msg))
	}
	end() { }
}