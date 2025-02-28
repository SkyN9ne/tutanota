import type { Commands } from "../common/MessageDispatcher"
import { errorToObj, MessageDispatcher, Request, WorkerTransport } from "../common/MessageDispatcher"
import { CryptoError } from "../common/error/CryptoError"
import { BookingFacade } from "./facades/BookingFacade"
import { NotAuthenticatedError } from "../common/error/RestError"
import { ProgrammingError } from "../common/error/ProgrammingError"
import { initLocator, locator, resetLocator } from "./WorkerLocator"
import { assertWorkerOrNode, isMainOrNode } from "../common/Env"
import type { ContactFormFacade } from "./facades/ContactFormFacade"
import type { BrowserData } from "../../misc/ClientConstants"
import { CryptoFacade } from "./crypto/CryptoFacade"
import type { GiftCardFacade } from "./facades/GiftCardFacade"
import type { LoginFacade } from "./facades/LoginFacade"
import type { CustomerFacade } from "./facades/CustomerFacade"
import type { GroupManagementFacade } from "./facades/GroupManagementFacade"
import { ConfigurationDatabase } from "./facades/ConfigurationDatabase"
import { CalendarFacade } from "./facades/CalendarFacade"
import { MailFacade } from "./facades/MailFacade"
import { ShareFacade } from "./facades/ShareFacade"
import { CounterFacade } from "./facades/CounterFacade"
import { Indexer } from "./search/Indexer"
import { SearchFacade } from "./search/SearchFacade"
import { MailAddressFacade } from "./facades/MailAddressFacade"
import { FileFacade } from "./facades/FileFacade.js"
import { UserManagementFacade } from "./facades/UserManagementFacade"
import { exposeLocal, exposeRemote } from "../common/WorkerProxy"
import type { DeviceEncryptionFacade } from "./facades/DeviceEncryptionFacade"
import { random } from "@tutao/tutanota-crypto"
import type { NativeInterface } from "../../native/common/NativeInterface"
import type { EntityRestInterface } from "./rest/EntityRestClient"
import { RestClient } from "./rest/RestClient"
import { IServiceExecutor } from "../common/ServiceRequest.js"
import { BlobFacade } from "./facades/BlobFacade"
import { ExposedCacheStorage } from "./rest/DefaultEntityRestCache.js"
import { LoginListener } from "../main/LoginListener"
import { BlobAccessTokenFacade } from "./facades/BlobAccessTokenFacade.js"
import { WebsocketConnectivityListener } from "../../misc/WebsocketConnectivityModel.js"
import { EventBusClient } from "./EventBusClient.js"
import { EntropyFacade } from "./facades/EntropyFacade.js"
import { ExposedProgressTracker } from "../main/ProgressTracker.js"
import { ExposedEventController } from "../main/EventController.js"
import { ExposedOperationProgressTracker } from "../main/OperationProgressTracker.js"
import { WorkerFacade } from "./facades/WorkerFacade.js"
import { InfoMessageHandler } from "../../gui/InfoMessageHandler.js"

assertWorkerOrNode()

export interface WorkerRandomizer {
	generateRandomNumber(numBytes: number): Promise<number>
}

export interface ExposedEventBus {
	tryReconnect: EventBusClient["tryReconnect"]
	close: EventBusClient["close"]
}

/** Interface of the facades exposed by the worker, basically interface for the worker itself */
export interface WorkerInterface {
	readonly loginFacade: LoginFacade
	readonly customerFacade: CustomerFacade
	readonly giftCardFacade: GiftCardFacade
	readonly groupManagementFacade: GroupManagementFacade
	readonly configFacade: ConfigurationDatabase
	readonly calendarFacade: CalendarFacade
	readonly mailFacade: MailFacade
	readonly shareFacade: ShareFacade
	readonly counterFacade: CounterFacade
	readonly indexerFacade: Indexer
	readonly searchFacade: SearchFacade
	readonly bookingFacade: BookingFacade
	readonly mailAddressFacade: MailAddressFacade
	readonly fileFacade: FileFacade
	readonly blobAccessTokenFacade: BlobAccessTokenFacade
	readonly blobFacade: BlobFacade
	readonly userManagementFacade: UserManagementFacade
	readonly contactFormFacade: ContactFormFacade
	readonly deviceEncryptionFacade: DeviceEncryptionFacade
	readonly restInterface: EntityRestInterface
	readonly serviceExecutor: IServiceExecutor
	readonly cryptoFacade: CryptoFacade
	readonly cacheStorage: ExposedCacheStorage
	readonly random: WorkerRandomizer
	readonly eventBus: ExposedEventBus
	readonly entropyFacade: EntropyFacade
	readonly workerFacade: WorkerFacade
}

/** Interface for the "main"/webpage context of the app, interface for the worker client. */
export interface MainInterface {
	readonly loginListener: LoginListener
	readonly wsConnectivityListener: WebsocketConnectivityListener
	readonly progressTracker: ExposedProgressTracker
	readonly eventController: ExposedEventController
	readonly operationProgressTracker: ExposedOperationProgressTracker
	readonly infoMessageHandler: InfoMessageHandler
}

type WorkerRequest = Request<WorkerRequestType>

export class WorkerImpl implements NativeInterface {
	private readonly _scope: DedicatedWorkerGlobalScope
	private readonly _dispatcher: MessageDispatcher<MainRequestType, WorkerRequestType>

	constructor(self: DedicatedWorkerGlobalScope) {
		this._scope = self
		this._dispatcher = new MessageDispatcher(new WorkerTransport(this._scope), this.queueCommands(this.exposedInterface))
	}

	async init(browserData: BrowserData): Promise<void> {
		await initLocator(this, browserData)
		const workerScope = this._scope

		// only register oncaught error handler if we are in the *real* worker scope
		// Otherwise uncaught error handler might end up in an infinite loop for test cases.
		if (workerScope && !isMainOrNode()) {
			workerScope.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
				this.sendError(event.reason)
			})

			// @ts-ignore
			workerScope.onerror = (e: string | Event, source, lineno, colno, error) => {
				console.error("workerImpl.onerror", e, source, lineno, colno, error)

				if (error instanceof Error) {
					this.sendError(error)
				} else {
					// @ts-ignore
					const err = new Error(e)
					// @ts-ignore
					err.lineNumber = lineno
					// @ts-ignore
					err.columnNumber = colno
					// @ts-ignore
					err.fileName = source
					this.sendError(err)
				}

				return true
			}
		}
	}

	get exposedInterface(): WorkerInterface {
		return {
			get loginFacade() {
				return locator.login
			},

			get customerFacade() {
				return locator.customer
			},

			get giftCardFacade() {
				return locator.giftCards
			},

			get groupManagementFacade() {
				return locator.groupManagement
			},

			get configFacade() {
				return locator.configFacade
			},

			get calendarFacade() {
				return locator.calendar
			},

			get mailFacade() {
				return locator.mail
			},

			get shareFacade() {
				return locator.share
			},

			get counterFacade() {
				return locator.counters
			},

			get indexerFacade() {
				return locator.indexer
			},

			get searchFacade() {
				return locator.search
			},

			get bookingFacade() {
				return locator.booking
			},

			get mailAddressFacade() {
				return locator.mailAddress
			},

			get fileFacade() {
				return locator.file
			},

			get blobAccessTokenFacade() {
				return locator.blobAccessToken
			},

			get blobFacade() {
				return locator.blob
			},

			get userManagementFacade() {
				return locator.userManagement
			},

			get contactFormFacade() {
				return locator.contactFormFacade
			},

			get deviceEncryptionFacade() {
				return locator.deviceEncryptionFacade
			},

			get restInterface() {
				return locator.cache
			},

			get serviceExecutor() {
				return locator.serviceExecutor
			},

			get cryptoFacade() {
				return locator.crypto
			},

			get cacheStorage() {
				return locator.cacheStorage
			},

			get random() {
				return {
					async generateRandomNumber(nbrOfBytes: number) {
						return random.generateRandomNumber(nbrOfBytes)
					},
				}
			},

			get eventBus() {
				return locator.eventBusClient
			},

			get entropyFacade() {
				return locator.entropyFacade
			},

			get workerFacade() {
				return locator.workerFacade
			},
		}
	}

	queueCommands(exposedWorker: WorkerInterface): Commands<WorkerRequestType> {
		return {
			setup: async (message) => {
				console.error("WorkerImpl: setup was called after bootstrap! message: ", message)
			},
			testEcho: (message) =>
				Promise.resolve({
					msg: ">>> " + message.args[0].msg,
				}),
			testError: (message) => {
				const errorTypes = {
					ProgrammingError,
					CryptoError,
					NotAuthenticatedError,
				}
				// @ts-ignore
				let ErrorType = errorTypes[message.args[0].errorType]
				return Promise.reject(new ErrorType(`wtf: ${message.args[0].errorType}`))
			},
			reset: (message: WorkerRequest) => {
				return resetLocator()
			},
			restRequest: (message: WorkerRequest) => {
				// This horror is to add auth headers to the admin client
				const args = message.args as Parameters<RestClient["request"]>
				let [path, method, options] = args
				options = options ?? {}
				options.headers = { ...locator.user.createAuthHeaders(), ...options.headers }
				return locator.restClient.request(path, method, options)
			},

			facade: exposeLocal(exposedWorker),
		}
	}

	invokeNative(requestType: string, args: ReadonlyArray<unknown>): Promise<any> {
		return this._dispatcher.postRequest(new Request("execNative", [requestType, args]))
	}

	getMainInterface(): MainInterface {
		return exposeRemote<MainInterface>((request) => this._dispatcher.postRequest(request))
	}

	sendError(e: Error): Promise<void> {
		return this._dispatcher.postRequest(new Request("error", [errorToObj(e)]))
	}
}
