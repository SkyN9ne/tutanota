import m from "mithril"
import stream from "mithril/stream"
import Stream from "mithril/stream"
import { containsEventOfType } from "../../api/common/utils/Utils"
import { assertNotNull, groupBy, neverNull, noOp, ofClass, splitInChunks } from "@tutao/tutanota-utils"
import type { Mail, MailBox, MailboxGroupRoot, MailboxProperties, MailFolder } from "../../api/entities/tutanota/TypeRefs.js"
import {
	createMailAddressProperties,
	createMailboxProperties,
	MailboxGroupRootTypeRef,
	MailboxPropertiesTypeRef,
	MailBoxTypeRef,
	MailFolderTypeRef,
	MailTypeRef,
} from "../../api/entities/tutanota/TypeRefs.js"
import type { Group, GroupInfo, GroupMembership, WebsocketCounterData } from "../../api/entities/sys/TypeRefs.js"
import { GroupInfoTypeRef, GroupTypeRef, UserTypeRef } from "../../api/entities/sys/TypeRefs.js"
import type { MailReportType } from "../../api/common/TutanotaConstants"
import {
	FeatureType,
	GroupType,
	MailFolderType,
	MAX_NBR_MOVE_DELETE_MAIL_SERVICE,
	OperationType,
	ReportMovedMailsType,
} from "../../api/common/TutanotaConstants"
import type { EntityUpdateData } from "../../api/main/EventController"
import { EventController, isUpdateForTypeRef } from "../../api/main/EventController"
import { lang } from "../../misc/LanguageViewModel"
import { Notifications } from "../../gui/Notifications"
import { findAndApplyMatchingRule } from "./InboxRuleHandler"
import { EntityClient } from "../../api/common/EntityClient"
import { elementIdPart, GENERATED_MAX_ID, getElementId, getListId, isSameId, listIdPart } from "../../api/common/utils/EntityUtils"
import { NotFoundError, PreconditionFailedError } from "../../api/common/error/RestError"
import type { MailFacade } from "../../api/worker/facades/MailFacade"
import { LoginController } from "../../api/main/LoginController.js"
import { getEnabledMailAddressesWithUser } from "./MailUtils.js"
import { ProgrammingError } from "../../api/common/error/ProgrammingError.js"
import { WebsocketConnectivityModel } from "../../misc/WebsocketConnectivityModel.js"
import { FolderSystem } from "../../api/common/mail/FolderSystem.js"
import { UserError } from "../../api/main/UserError.js"
import { assertSystemFolderOfType, isSpamOrTrashFolder } from "../../api/common/mail/CommonMailUtils.js"

export type MailboxDetail = {
	mailbox: MailBox
	folders: FolderSystem
	mailGroupInfo: GroupInfo
	mailGroup: Group
	mailboxGroupRoot: MailboxGroupRoot
}
export type MailboxCounters = Record<Id, Record<string, number>>

export class MailModel {
	/** Empty stream until init() is finished, exposed mostly for map()-ing, use getMailboxDetails to get a promise */
	mailboxDetails: Stream<MailboxDetail[]>
	mailboxCounters: Stream<MailboxCounters>
	private initialization: Promise<any> | null
	/**
	 * Map from MailboxGroupRoot id to MailboxProperties
	 * A way to avoid race conditions in case we try to create mailbox properties from multiple places.
	 *
	 */
	private mailboxPropertiesPromises: Map<Id, Promise<MailboxProperties>> = new Map()

	constructor(
		private readonly notifications: Notifications,
		private readonly eventController: EventController,
		private readonly connectivityModel: WebsocketConnectivityModel,
		private readonly mailFacade: MailFacade,
		private readonly entityClient: EntityClient,
		private readonly logins: LoginController,
	) {
		this.mailboxDetails = stream()
		this.mailboxCounters = stream({})
		this.initialization = null
	}

	init(): Promise<void> {
		if (this.initialization) {
			return this.initialization
		}

		this.eventController.addEntityListener((updates) => this.entityEventsReceived(updates))

		this.eventController.getCountersStream().map((update) => {
			this._mailboxCountersUpdates(update)
		})

		return this._init()
	}

	private _init(): Promise<void> {
		const mailGroupMemberships = this.logins.getUserController().getMailGroupMemberships()
		const mailBoxDetailsPromises = mailGroupMemberships.map((m) => this.mailboxDetailsFromMembership(m))
		this.initialization = Promise.all(mailBoxDetailsPromises).then((details) => this.mailboxDetails(details))
		return this.initialization
	}

	/**
	 * load mailbox details from a mailgroup membership
	 */
	private async mailboxDetailsFromMembership(membership: GroupMembership): Promise<MailboxDetail> {
		const [mailboxGroupRoot, mailGroupInfo, mailGroup] = await Promise.all([
			this.entityClient.load(MailboxGroupRootTypeRef, membership.group),
			this.entityClient.load(GroupInfoTypeRef, membership.groupInfo),
			this.entityClient.load(GroupTypeRef, membership.group),
		])
		const mailbox = await this.entityClient.load(MailBoxTypeRef, mailboxGroupRoot.mailbox)
		const folders = await this.loadFolders(neverNull(mailbox.folders).folders)
		return {
			mailbox,
			folders: new FolderSystem(folders),
			mailGroupInfo,
			mailGroup,
			mailboxGroupRoot,
		}
	}

	private loadFolders(folderListId: Id): Promise<MailFolder[]> {
		return this.entityClient.loadAll(MailFolderTypeRef, folderListId).then((folders) => {
			return folders.filter((f) => {
				// We do not show spam or archive for external users
				if (!this.logins.isInternalUserLoggedIn() && (f.folderType === MailFolderType.SPAM || f.folderType === MailFolderType.ARCHIVE)) {
					return false
				} else if (this.logins.isEnabled(FeatureType.InternalCommunication) && f.folderType === MailFolderType.SPAM) {
					return false
				} else {
					return true
				}
			})
		})
	}

	/**
	 * get the list of MailboxDetails that this user has access to from their memberships
	 */
	async getMailboxDetails(): Promise<Array<MailboxDetail>> {
		await this.init()
		return this.mailboxDetails()
	}

	getMailboxDetailsForMail(mail: Mail): Promise<MailboxDetail> {
		return this.getMailboxDetailsForMailListId(mail._id[0])
	}

	async getMailboxDetailsForMailListId(mailListId: Id): Promise<MailboxDetail> {
		const mailboxDetails = await this.getMailboxDetails()
		return assertNotNull(mailboxDetails.find((md) => md.folders.getFolderByMailListId(mailListId)))
	}

	async getMailboxDetailsForMailGroup(mailGroupId: Id): Promise<MailboxDetail> {
		const mailboxDetails = await this.getMailboxDetails()
		return assertNotNull(
			mailboxDetails.find((md) => mailGroupId === md.mailGroup._id),
			"No mailbox details for mail group",
		)
	}

	async getUserMailboxDetails(): Promise<MailboxDetail> {
		const userMailGroupMembership = this.logins.getUserController().getUserMailGroupMembership()
		const mailboxDetails = await this.getMailboxDetails()
		return assertNotNull(mailboxDetails.find((md) => md.mailGroup._id === userMailGroupMembership.group))
	}

	getMailboxFolders(mail: Mail): Promise<FolderSystem> {
		return this.getMailboxDetailsForMail(mail).then((md) => md.folders)
	}

	getMailFolder(mailListId: Id): MailFolder | null {
		const mailboxDetails = this.mailboxDetails() || []

		for (let detail of mailboxDetails) {
			const f = detail.folders.getFolderByMailListId(mailListId)
			if (f) {
				return f
			}
		}

		return null
	}

	/**
	 * Sends the given folder and all its descendants to the spam folder, reporting mails (if applicable) and removes any empty folders
	 */
	async sendFolderToSpam(folder: MailFolder): Promise<void> {
		const mailboxDetail = await this.getMailboxDetailsForMailListId(folder.mails)

		let deletedFolder = await this.removeAllEmpty(mailboxDetail, folder)
		if (!deletedFolder) {
			return this.mailFacade.updateMailFolderParent(folder, assertSystemFolderOfType(mailboxDetail.folders, MailFolderType.SPAM)._id)
		}
	}

	async reportMails(reportType: MailReportType, mails: ReadonlyArray<Mail>): Promise<void> {
		for (const mail of mails) {
			await this.mailFacade.reportMail(mail, reportType).catch(ofClass(NotFoundError, (e) => console.log("mail to be reported not found", e)))
		}
	}

	/**
	 * Finally deletes all given mails. Caller must ensure that mails are only from one folder
	 */
	async _moveMails(mails: Mail[], targetMailFolder: MailFolder): Promise<void> {
		let moveMails = mails.filter((m) => m._id[0] !== targetMailFolder.mails && targetMailFolder._ownerGroup === m._ownerGroup) // prevent moving mails between mail boxes.

		// Do not move if target is the same as the current mailFolder
		const sourceMailFolder = this.getMailFolder(getListId(mails[0]))

		if (moveMails.length > 0 && sourceMailFolder && !isSameId(targetMailFolder._id, sourceMailFolder._id)) {
			const mailChunks = splitInChunks(
				MAX_NBR_MOVE_DELETE_MAIL_SERVICE,
				mails.map((m) => m._id),
			)

			for (const mailChunk of mailChunks) {
				await this.mailFacade.moveMails(mailChunk, targetMailFolder._id)
			}
		}
	}

	/**
	 * Preferably use moveMails() in MailGuiUtils.js which has built-in error handling
	 * @throws PreconditionFailedError or LockedError if operation is locked on the server
	 */
	async moveMails(mails: ReadonlyArray<Mail>, targetMailFolder: MailFolder): Promise<void> {
		const mailsPerFolder = groupBy(mails, (mail) => {
			return getListId(mail)
		})

		for (const [listId, mails] of mailsPerFolder) {
			const sourceMailFolder = this.getMailFolder(listId)

			if (sourceMailFolder) {
				await this._moveMails(mails, targetMailFolder)
			} else {
				console.log("Move mail: no mail folder for list id", listId)
			}
		}
	}

	/**
	 * Finally deletes the given mails if they are already in the trash or spam folders,
	 * otherwise moves them to the trash folder.
	 * A deletion confirmation must have been show before.
	 */
	async deleteMails(mails: ReadonlyArray<Mail>): Promise<void> {
		const mailsPerFolder = groupBy(mails, (mail) => {
			return getListId(mail)
		})

		if (mails.length === 0) {
			return
		}
		const folders = await this.getMailboxFolders(mails[0])
		const trashFolder = assertNotNull(folders.getSystemFolderByType(MailFolderType.TRASH))

		for (const [listId, mails] of mailsPerFolder) {
			const sourceMailFolder = this.getMailFolder(listId)

			if (sourceMailFolder) {
				if (isSpamOrTrashFolder(folders, sourceMailFolder)) {
					await this._finallyDeleteMails(mails)
				} else {
					await this._moveMails(mails, trashFolder)
				}
			} else {
				console.log("Delete mail: no mail folder for list id", listId)
			}
		}
	}

	/**
	 * Finally deletes all given mails. Caller must ensure that mails are only from one folder and the folder must allow final delete operation.
	 */
	async _finallyDeleteMails(mails: Mail[]): Promise<void> {
		if (!mails.length) return Promise.resolve()
		const mailFolder = neverNull(this.getMailFolder(getListId(mails[0])))
		const mailIds = mails.map((m) => m._id)
		const mailChunks = splitInChunks(MAX_NBR_MOVE_DELETE_MAIL_SERVICE, mailIds)

		for (const mailChunk of mailChunks) {
			await this.mailFacade.deleteMails(mailChunk, mailFolder._id)
		}
	}

	async entityEventsReceived(updates: ReadonlyArray<EntityUpdateData>): Promise<void> {
		for (const update of updates) {
			if (isUpdateForTypeRef(MailFolderTypeRef, update)) {
				await this._init()
				m.redraw()
			} else if (isUpdateForTypeRef(GroupInfoTypeRef, update)) {
				if (update.operation === OperationType.UPDATE) {
					await this._init()
					m.redraw
				}
			} else if (isUpdateForTypeRef(UserTypeRef, update)) {
				if (update.operation === OperationType.UPDATE && isSameId(this.logins.getUserController().user._id, update.instanceId)) {
					const updatedUser = await this.entityClient.load(UserTypeRef, update.instanceId)
					let newMemberships = updatedUser.memberships.filter((membership) => membership.groupType === GroupType.Mail)
					const mailboxDetails = await this.getMailboxDetails()

					if (newMemberships.length !== mailboxDetails.length) {
						await this._init()
						m.redraw()
					}
				}
			} else if (isUpdateForTypeRef(MailTypeRef, update) && update.operation === OperationType.CREATE) {
				const folder = this.getMailFolder(update.instanceListId)

				if (folder && folder.folderType === MailFolderType.INBOX && !containsEventOfType(updates, OperationType.DELETE, update.instanceId)) {
					// If we don't find another delete operation on this email in the batch, then it should be a create operation,
					// otherwise it's a move
					const mailId: IdTuple = [update.instanceListId, update.instanceId]
					const mail = await this.entityClient.load(MailTypeRef, mailId)
					await this.getMailboxDetailsForMailListId(update.instanceListId)
						.then((mailboxDetail) => {
							// We only apply rules on server if we are the leader in case of incoming messages
							return findAndApplyMatchingRule(this.mailFacade, this.entityClient, mailboxDetail, mail, this.connectivityModel.isLeader())
						})
						.then((newId) => this._showNotification(newId || mailId))
						.catch(noOp)
				}
			}
		}
	}

	_mailboxCountersUpdates(counters: WebsocketCounterData) {
		const normalized = this.mailboxCounters() || {}
		const group = normalized[counters.mailGroup] || {}
		counters.counterValues.forEach((value) => {
			group[value.mailListId] = Number(value.count) || 0
		})
		normalized[counters.mailGroup] = group
		this.mailboxCounters(normalized)
	}

	_showNotification(mailId: IdTuple) {
		this.notifications.showNotification(
			lang.get("newMails_msg"),
			{
				actions: [],
			},
			(e) => {
				m.route.set(`/mail/${listIdPart(mailId)}/${elementIdPart(mailId)}`)
				window.focus()
			},
		)
	}

	getCounterValue(listId: Id): Promise<number | null> {
		return this.getMailboxDetailsForMailListId(listId)
			.then((mailboxDetails) => {
				const counters = this.mailboxCounters()
				const mailGroupCounter = counters[mailboxDetails.mailGroup._id]
				return mailGroupCounter && mailGroupCounter[listId]
			})
			.catch(() => null)
	}

	checkMailForPhishing(
		mail: Mail,
		links: Array<{
			href: string
			innerHTML: string
		}>,
	): Promise<boolean> {
		return this.mailFacade.checkMailForPhishing(mail, links)
	}

	/**
	 * Sends the given folder and all its descendants to the trash folder, removes any empty folders
	 */
	async trashFolderAndSubfolders(folder: MailFolder): Promise<void> {
		const mailboxDetail = await this.getMailboxDetailsForMailListId(folder.mails)
		let deletedFolder = await this.removeAllEmpty(mailboxDetail, folder)
		if (!deletedFolder) {
			const trash = assertSystemFolderOfType(mailboxDetail.folders, MailFolderType.TRASH)
			return this.mailFacade.updateMailFolderParent(folder, trash._id)
		}
	}

	/**
	 * This is called when moving a folder to SPAM or TRASH, which do not allow empty folders (since only folders that contain mail are allowed)
	 */
	private async removeAllEmpty(mailboxDetail: MailboxDetail, folder: MailFolder): Promise<boolean> {
		// sort descendants deepest first so that we can clean them up before checking their ancestors
		const descendants = mailboxDetail.folders.getDescendantFoldersOfParent(folder._id).sort((l, r) => r.level - l.level)

		// we completely delete empty folders
		let someNonEmpty = false
		// we don't update folder system quickly enough so we keep track of deleted folders here and consider them "empty" when all their children are here
		const deleted = new Set<Id>()
		for (const descendant of descendants) {
			// Only load one mail, if there is even one we won't remove
			if (
				(await this.entityClient.loadRange(MailTypeRef, descendant.folder.mails, GENERATED_MAX_ID, 1, true)).length === 0 &&
				mailboxDetail.folders.getCustomFoldersOfParent(descendant.folder._id).every((f) => deleted.has(getElementId(f)))
			) {
				deleted.add(getElementId(descendant.folder))
				await this.finallyDeleteCustomMailFolder(descendant.folder)
			} else {
				someNonEmpty = true
			}
		}
		// Only load one mail, if there is even one we won't remove
		if (
			(await this.entityClient.loadRange(MailTypeRef, folder.mails, GENERATED_MAX_ID, 1, true)).length === 0 &&
			mailboxDetail.folders.getCustomFoldersOfParent(folder._id).every((f) => deleted.has(getElementId(f))) &&
			!someNonEmpty
		) {
			await this.finallyDeleteCustomMailFolder(folder)
			return true
		} else {
			return false
		}
	}

	public async finallyDeleteCustomMailFolder(folder: MailFolder): Promise<void> {
		if (folder.folderType !== MailFolderType.CUSTOM) {
			throw new ProgrammingError("Cannot delete non-custom folder: " + String(folder._id))
		}

		return await this.mailFacade
			.deleteFolder(folder._id)
			.catch(ofClass(NotFoundError, () => console.log("mail folder already deleted")))
			.catch(
				ofClass(PreconditionFailedError, () => {
					throw new UserError("operationStillActive_msg")
				}),
			)
	}

	async fixupCounterForMailList(listId: Id, unreadMails: number) {
		const mailboxDetails = await this.getMailboxDetailsForMailListId(listId)
		await this.mailFacade.fixupCounterForMailList(mailboxDetails.mailGroup._id, listId, unreadMails)
	}

	async clearFolder(folder: MailFolder): Promise<void> {
		await this.mailFacade.clearFolder(folder._id)
	}

	async unsubscribe(mail: Mail, recipient: string, headers: string[]) {
		await this.mailFacade.unsubscribe(mail._id, recipient, headers)
	}

	async getMailboxProperties(mailboxGroupRoot: MailboxGroupRoot): Promise<MailboxProperties> {
		// MailboxProperties is an encrypted instance that is created lazily. When we create it the reference is automatically written to the MailboxGroupRoot.
		// Unfortunately we will only get updated new MailboxGroupRoot with the next EntityUpdate.
		// To prevent parallel creation attempts we do two things:
		//  - we save the loading promise to avoid calling setup() twice in parallel
		//  - we set mailboxProperties reference manually (we could save the id elsewhere but it's easier this way)

		// If we are already loading/creating, just return it to avoid races
		const existingPromise = this.mailboxPropertiesPromises.get(mailboxGroupRoot._id)
		if (existingPromise) {
			return existingPromise
		}

		const promise: Promise<MailboxProperties> = this.loadOrCreateMailboxProperties(mailboxGroupRoot)
		this.mailboxPropertiesPromises.set(mailboxGroupRoot._id, promise)
		return promise.finally(() => this.mailboxPropertiesPromises.delete(mailboxGroupRoot._id))
	}

	private async loadOrCreateMailboxProperties(mailboxGroupRoot: MailboxGroupRoot): Promise<MailboxProperties> {
		if (!mailboxGroupRoot.mailboxProperties) {
			mailboxGroupRoot.mailboxProperties = await this.entityClient
				.setup(
					null,
					createMailboxProperties({
						_ownerGroup: mailboxGroupRoot._ownerGroup,
					}),
				)
				.catch(
					ofClass(PreconditionFailedError, (e) => {
						// We try to prevent race conditions but they can still happen with multiple clients trying ot create mailboxProperties at the same time.
						// We send special precondition from the server with an existing id.
						if (e.data && e.data.startsWith("exists:")) {
							const existingId = e.data.substring("exists:".length)
							console.log("mailboxProperties already exists", existingId)
							return existingId
						} else {
							throw new ProgrammingError(`Could not create mailboxProperties, precondition: ${e.data}`)
						}
					}),
				)
		}
		const mailboxProperties = await this.entityClient.load(MailboxPropertiesTypeRef, mailboxGroupRoot.mailboxProperties)
		if (mailboxProperties.mailAddressProperties.length === 0) {
			await this.migrateFromOldSenderName(mailboxGroupRoot, mailboxProperties)
		}
		return mailboxProperties
	}

	/** If there was no sender name configured before take the user's name and assign it to all email addresses. */
	private async migrateFromOldSenderName(mailboxGroupRoot: MailboxGroupRoot, mailboxProperties: MailboxProperties) {
		const userGroupInfo = this.logins.getUserController().userGroupInfo
		const legacySenderName = userGroupInfo.name
		const mailboxDetails = await this.getMailboxDetailsForMailGroup(mailboxGroupRoot._id)
		const mailAddresses = getEnabledMailAddressesWithUser(mailboxDetails, userGroupInfo)
		for (const mailAddress of mailAddresses) {
			mailboxProperties.mailAddressProperties.push(
				createMailAddressProperties({
					mailAddress,
					senderName: legacySenderName,
				}),
			)
		}
		await this.entityClient.update(mailboxProperties)
	}

	async saveReportMovedMails(mailboxGroupRoot: MailboxGroupRoot, reportMovedMails: ReportMovedMailsType): Promise<MailboxProperties> {
		const mailboxProperties = await this.loadOrCreateMailboxProperties(mailboxGroupRoot)
		mailboxProperties.reportMovedMails = reportMovedMails
		await this.entityClient.update(mailboxProperties)
		return mailboxProperties
	}
}
