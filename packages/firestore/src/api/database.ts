/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Value as ProtoValue } from '../protos/firestore_proto_api';

import { FirebaseApp } from '@firebase/app-types';
import { _FirebaseApp, FirebaseService } from '@firebase/app-types/private';
import { DatabaseId } from '../core/database_info';
import { ListenOptions } from '../core/event_manager';
import {
  FirestoreClient,
  firestoreClientGetDocumentsFromLocalCache,
  firestoreClientGetDocumentsViaSnapshotListener,
  firestoreClientListen,
  firestoreClientTransaction,
  firestoreClientWrite
} from '../core/firestore_client';
import {
  Bound,
  Direction,
  FieldFilter,
  Filter,
  findFilterOperator,
  getFirstOrderByField,
  getInequalityFilterField,
  hasLimitToLast,
  isCollectionGroupQuery,
  LimitType,
  newQueryComparator,
  newQueryForCollectionGroup,
  newQueryForPath,
  Operator,
  OrderBy,
  Query as InternalQuery,
  queryEquals,
  queryOrderBy,
  queryWithAddedFilter,
  queryWithAddedOrderBy,
  queryWithEndAt,
  queryWithLimit,
  queryWithStartAt
} from '../core/query';
import { Transaction as InternalTransaction } from '../core/transaction';
import { ChangeType, ViewSnapshot } from '../core/view_snapshot';
import { Document, MaybeDocument, NoDocument } from '../model/document';
import { DocumentKey } from '../model/document_key';
import { DeleteMutation, Mutation, Precondition } from '../model/mutation';
import { FieldPath, ResourcePath } from '../model/path';
import { isServerTimestamp } from '../model/server_timestamps';
import { refValue } from '../model/values';
import { debugAssert, fail } from '../util/assert';
import { Code, FirestoreError } from '../util/error';
import {
  cast,
  validateIsNotUsedTogether,
  validateNonEmptyArgument,
  validatePositiveNumber,
  validateSetOptions,
  valueDescription
} from '../util/input_validation';
import { logWarn, setLogLevel as setClientLogLevel } from '../util/log';
import { AutoId } from '../util/misc';
import { FieldPath as ExpFieldPath } from '../../lite/src/api/field_path';
import {
  CompleteFn,
  ErrorFn,
  isPartialObserver,
  NextFn,
  PartialObserver,
  Unsubscribe
} from './observer';
import {
  fieldPathFromArgument,
  parseQueryValue,
  parseSetData,
  parseUpdateData,
  parseUpdateVarargs,
  UntypedFirestoreDataConverter,
  UserDataReader
} from './user_data_reader';
import { UserDataWriter } from './user_data_writer';
import {
  clearIndexedDbPersistence,
  disableNetwork,
  enableIndexedDbPersistence,
  enableMultiTabIndexedDbPersistence,
  enableNetwork,
  FirebaseFirestore,
  terminate,
  waitForPendingWrites,
  FirebaseFirestore as ExpFirebaseFirestore
} from '../../exp/src/api/database';
import {
  DocumentSnapshot as ExpDocumentSnapshot,
  QueryDocumentSnapshot as ExpQueryDocumentSnapshot,
  snapshotEqual
} from '../../exp/src/api/snapshot';
import {
  DocumentReference as ExpDocumentReference,
  refEqual,
  newUserDataReader
} from '../../lite/src/api/reference';
import {
  onSnapshotsInSync,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocFromCache,
  getDocFromServer,
  getDoc,
  onSnapshot
} from '../../exp/src/api/reference';
import { LRU_COLLECTION_DISABLED } from '../local/lru_garbage_collector';
import { Compat } from '../compat/compat';

import {
  CollectionReference as PublicCollectionReference,
  DocumentChange as PublicDocumentChange,
  DocumentChangeType as PublicDocumentChangeType,
  DocumentData as PublicDocumentData,
  DocumentReference as PublicDocumentReference,
  DocumentSnapshot as PublicDocumentSnapshot,
  FieldPath as PublicFieldPath,
  FirebaseFirestore as PublicFirestore,
  FirestoreDataConverter as PublicFirestoreDataConverter,
  GetOptions as PublicGetOptions,
  LogLevel as PublicLogLevel,
  OrderByDirection as PublicOrderByDirection,
  PersistenceSettings as PublicPersistenceSettings,
  Query as PublicQuery,
  QueryDocumentSnapshot as PublicQueryDocumentSnapshot,
  QuerySnapshot as PublicQuerySnapshot,
  SetOptions as PublicSetOptions,
  Settings as PublicSettings,
  SnapshotListenOptions as PublicSnapshotListenOptions,
  SnapshotMetadata as PublicSnapshotMetadata,
  SnapshotOptions as PublicSnapshotOptions,
  Transaction as PublicTransaction,
  UpdateData as PublicUpdateData,
  WhereFilterOp as PublicWhereFilterOp,
  WriteBatch as PublicWriteBatch
} from '@firebase/firestore-types';

import { makeDatabaseInfo } from '../../lite/src/api/database';
import { DEFAULT_HOST } from '../../lite/src/api/components';

/**
 * Constant used to indicate the LRU garbage collection should be disabled.
 * Set this value as the `cacheSizeBytes` on the settings passed to the
 * `Firestore` instance.
 */
export const CACHE_SIZE_UNLIMITED = LRU_COLLECTION_DISABLED;

/**
 * A persistence provider for either memory-only or IndexedDB persistence.
 * Mainly used to allow optional inclusion of IndexedDB code.
 */
export interface PersistenceProvider {
  enableIndexedDbPersistence(
    firestore: Firestore,
    forceOwnership: boolean
  ): Promise<void>;
  enableMultiTabIndexedDbPersistence(firestore: Firestore): Promise<void>;
  clearIndexedDbPersistence(firestore: Firestore): Promise<void>;
}

const MEMORY_ONLY_PERSISTENCE_ERROR_MESSAGE =
  'You are using the memory-only build of Firestore. Persistence support is ' +
  'only available via the @firebase/firestore bundle or the ' +
  'firebase-firestore.js build.';

/**
 * The persistence provider included with the memory-only SDK. This provider
 * errors for all attempts to access persistence.
 */
export class MemoryPersistenceProvider implements PersistenceProvider {
  enableIndexedDbPersistence(
    firestore: Firestore,
    forceOwnership: boolean
  ): Promise<void> {
    throw new FirestoreError(
      Code.FAILED_PRECONDITION,
      MEMORY_ONLY_PERSISTENCE_ERROR_MESSAGE
    );
  }

  enableMultiTabIndexedDbPersistence(firestore: Firestore): Promise<void> {
    throw new FirestoreError(
      Code.FAILED_PRECONDITION,
      MEMORY_ONLY_PERSISTENCE_ERROR_MESSAGE
    );
  }

  clearIndexedDbPersistence(firestore: Firestore): Promise<void> {
    throw new FirestoreError(
      Code.FAILED_PRECONDITION,
      MEMORY_ONLY_PERSISTENCE_ERROR_MESSAGE
    );
  }
}

/**
 * The persistence provider included with the full Firestore SDK.
 */
export class IndexedDbPersistenceProvider implements PersistenceProvider {
  enableIndexedDbPersistence(
    firestore: Firestore,
    forceOwnership: boolean
  ): Promise<void> {
    return enableIndexedDbPersistence(firestore._delegate, { forceOwnership });
  }
  enableMultiTabIndexedDbPersistence(firestore: Firestore): Promise<void> {
    return enableMultiTabIndexedDbPersistence(firestore._delegate);
  }
  clearIndexedDbPersistence(firestore: Firestore): Promise<void> {
    return clearIndexedDbPersistence(firestore._delegate);
  }
}

/**
 * Compat class for Firestore. Exposes Firestore Legacy API, but delegates
 * to the functional API of firestore-exp.
 */
export class Firestore
  extends Compat<ExpFirebaseFirestore>
  implements PublicFirestore, FirebaseService {
  _appCompat?: FirebaseApp;
  constructor(
    databaseIdOrApp: DatabaseId | FirebaseApp,
    delegate: ExpFirebaseFirestore,
    private _persistenceProvider: PersistenceProvider
  ) {
    super(delegate);

    if (!(databaseIdOrApp instanceof DatabaseId)) {
      this._appCompat = databaseIdOrApp as FirebaseApp;
    }
  }

  get _databaseId(): DatabaseId {
    return this._delegate._databaseId;
  }

  settings(settingsLiteral: PublicSettings): void {
    if (settingsLiteral.merge) {
      settingsLiteral = {
        ...this._delegate._getSettings(),
        ...settingsLiteral
      };
      // Remove the property from the settings once the merge is completed
      delete settingsLiteral.merge;
    }
    this._delegate._setSettings(settingsLiteral);
  }

  useEmulator(host: string, port: number): void {
    if (this._delegate._getSettings().host !== DEFAULT_HOST) {
      logWarn(
        'Host has been set in both settings() and useEmulator(), emulator host will be used'
      );
    }

    this.settings({
      host: `${host}:${port}`,
      ssl: false,
      merge: true
    });
  }

  enableNetwork(): Promise<void> {
    return enableNetwork(this._delegate);
  }

  disableNetwork(): Promise<void> {
    return disableNetwork(this._delegate);
  }

  enablePersistence(settings?: PublicPersistenceSettings): Promise<void> {
    let synchronizeTabs = false;
    let experimentalForceOwningTab = false;

    if (settings) {
      synchronizeTabs = !!settings.synchronizeTabs;
      experimentalForceOwningTab = !!settings.experimentalForceOwningTab;

      validateIsNotUsedTogether(
        'synchronizeTabs',
        synchronizeTabs,
        'experimentalForceOwningTab',
        experimentalForceOwningTab
      );
    }

    return synchronizeTabs
      ? this._persistenceProvider.enableMultiTabIndexedDbPersistence(this)
      : this._persistenceProvider.enableIndexedDbPersistence(
          this,
          experimentalForceOwningTab
        );
  }

  clearPersistence(): Promise<void> {
    return this._persistenceProvider.clearIndexedDbPersistence(this);
  }

  terminate(): Promise<void> {
    (this.app as _FirebaseApp)._removeServiceInstance('firestore');
    return this.INTERNAL.delete();
  }

  waitForPendingWrites(): Promise<void> {
    return waitForPendingWrites(this._delegate);
  }

  onSnapshotsInSync(observer: PartialObserver<void>): Unsubscribe;
  onSnapshotsInSync(onSync: () => void): Unsubscribe;
  onSnapshotsInSync(arg: unknown): Unsubscribe {
    return onSnapshotsInSync(this._delegate, arg as PartialObserver<void>);
  }

  get app(): FirebaseApp {
    if (!this._appCompat) {
      throw new FirestoreError(
        Code.FAILED_PRECONDITION,
        "Firestore was not initialized using the Firebase SDK. 'app' is " +
          'not available'
      );
    }
    return this._appCompat as FirebaseApp;
  }

  INTERNAL = {
    delete: () => terminate(this._delegate)
  };

  collection(pathString: string): PublicCollectionReference {
    validateNonEmptyArgument('Firestore.collection', 'path', pathString);
    ensureFirestoreConfigured(this._delegate);
    return new CollectionReference(
      ResourcePath.fromString(pathString),
      this,
      /* converter= */ null
    );
  }

  doc(pathString: string): PublicDocumentReference {
    validateNonEmptyArgument('Firestore.doc', 'path', pathString);
    ensureFirestoreConfigured(this._delegate);
    return DocumentReference.forPath(
      ResourcePath.fromString(pathString),
      this,
      /* converter= */ null
    );
  }

  collectionGroup(collectionId: string): PublicQuery {
    validateNonEmptyArgument(
      'Firestore.collectionGroup',
      'collectionId',
      collectionId
    );
    if (collectionId.indexOf('/') >= 0) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        `Invalid collection ID '${collectionId}' passed to function ` +
          `Firestore.collectionGroup(). Collection IDs must not contain '/'.`
      );
    }
    ensureFirestoreConfigured(this._delegate);
    return new Query(
      newQueryForCollectionGroup(collectionId),
      this,
      /* converter= */ null
    );
  }

  runTransaction<T>(
    updateFunction: (transaction: PublicTransaction) => Promise<T>
  ): Promise<T> {
    const client = ensureFirestoreConfigured(this._delegate);
    return firestoreClientTransaction(
      client,
      (transaction: InternalTransaction) => {
        return updateFunction(new Transaction(this, transaction));
      }
    );
  }

  batch(): PublicWriteBatch {
    ensureFirestoreConfigured(this._delegate);
    return new WriteBatch(this);
  }
}

export function ensureFirestoreConfigured(
  firestore: FirebaseFirestore
): FirestoreClient {
  if (!firestore._firestoreClient) {
    configureFirestore(firestore);
  }
  firestore._firestoreClient!.verifyNotTerminated();
  return firestore._firestoreClient as FirestoreClient;
}

export function configureFirestore(firestore: FirebaseFirestore): void {
  const settings = firestore._freezeSettings();
  debugAssert(!!settings.host, 'FirestoreSettings.host is not set');
  debugAssert(
    !firestore._firestoreClient,
    'configureFirestore() called multiple times'
  );

  const databaseInfo = makeDatabaseInfo(
    firestore._databaseId,
    firestore._persistenceKey,
    settings
  );
  firestore._firestoreClient = new FirestoreClient(
    firestore._credentials,
    firestore._queue,
    databaseInfo
  );
}

export function setLogLevel(level: PublicLogLevel): void {
  setClientLogLevel(level);
}

/**
 * A reference to a transaction.
 */
export class Transaction implements PublicTransaction {
  private _dataReader: UserDataReader;

  constructor(
    private _firestore: Firestore,
    private _transaction: InternalTransaction
  ) {
    this._dataReader = newUserDataReader(this._firestore._delegate);
  }

  get<T>(
    documentRef: PublicDocumentReference<T>
  ): Promise<PublicDocumentSnapshot<T>> {
    const ref = validateReference(
      'Transaction.get',
      documentRef,
      this._firestore
    );
    const userDataWriter = new UserDataWriter(this._firestore);
    return this._transaction
      .lookup([ref._key])
      .then((docs: MaybeDocument[]) => {
        if (!docs || docs.length !== 1) {
          return fail('Mismatch in docs returned from document lookup.');
        }
        const doc = docs[0];
        if (doc instanceof NoDocument) {
          return new DocumentSnapshot<T>(
            this._firestore,
            new ExpDocumentSnapshot(
              this._firestore._delegate,
              userDataWriter,
              ref._key,
              null,
              new SnapshotMetadata(
                /*hasPendingWrites= */ false,
                /* fromCache= */ false
              ),
              ref._converter
            )
          );
        } else if (doc instanceof Document) {
          return new DocumentSnapshot<T>(
            this._firestore,
            new ExpDocumentSnapshot(
              this._firestore._delegate,
              userDataWriter,
              ref._key,
              doc,
              new SnapshotMetadata(
                /*hasPendingWrites= */ false,
                /* fromCache= */ false
              ),
              ref._converter
            )
          );
        } else {
          throw fail(
            `BatchGetDocumentsRequest returned unexpected document type: ${doc.constructor.name}`
          );
        }
      });
  }

  set<T>(
    documentRef: DocumentReference<T>,
    data: Partial<T>,
    options: PublicSetOptions
  ): Transaction;
  set<T>(documentRef: DocumentReference<T>, data: T): Transaction;
  set<T>(
    documentRef: PublicDocumentReference<T>,
    value: T | Partial<T>,
    options?: PublicSetOptions
  ): Transaction {
    const ref = validateReference(
      'Transaction.set',
      documentRef,
      this._firestore
    );
    options = validateSetOptions('Transaction.set', options);
    const convertedValue = applyFirestoreDataConverter(
      ref._converter,
      value,
      options
    );
    const parsed = parseSetData(
      this._dataReader,
      'Transaction.set',
      ref._key,
      convertedValue,
      ref._converter !== null,
      options
    );
    this._transaction.set(ref._key, parsed);
    return this;
  }

  update(
    documentRef: PublicDocumentReference<unknown>,
    value: PublicUpdateData
  ): Transaction;
  update(
    documentRef: PublicDocumentReference<unknown>,
    field: string | PublicFieldPath,
    value: unknown,
    ...moreFieldsAndValues: unknown[]
  ): Transaction;
  update(
    documentRef: PublicDocumentReference<unknown>,
    fieldOrUpdateData: string | PublicFieldPath | PublicUpdateData,
    value?: unknown,
    ...moreFieldsAndValues: unknown[]
  ): Transaction {
    const ref = validateReference(
      'Transaction.update',
      documentRef,
      this._firestore
    );

    // For Compat types, we have to "extract" the underlying types before
    // performing validation.
    if (fieldOrUpdateData instanceof Compat) {
      fieldOrUpdateData = (fieldOrUpdateData as Compat<ExpFieldPath>)._delegate;
    }

    let parsed;
    if (
      typeof fieldOrUpdateData === 'string' ||
      fieldOrUpdateData instanceof ExpFieldPath
    ) {
      parsed = parseUpdateVarargs(
        this._dataReader,
        'Transaction.update',
        ref._key,
        fieldOrUpdateData,
        value,
        moreFieldsAndValues
      );
    } else {
      parsed = parseUpdateData(
        this._dataReader,
        'Transaction.update',
        ref._key,
        fieldOrUpdateData
      );
    }

    this._transaction.update(ref._key, parsed);
    return this;
  }

  delete(documentRef: PublicDocumentReference<unknown>): Transaction {
    const ref = validateReference(
      'Transaction.delete',
      documentRef,
      this._firestore
    );
    this._transaction.delete(ref._key);
    return this;
  }
}

export class WriteBatch implements PublicWriteBatch {
  private _mutations = [] as Mutation[];
  private _committed = false;
  private _dataReader: UserDataReader;

  constructor(private _firestore: Firestore) {
    this._dataReader = newUserDataReader(this._firestore._delegate);
  }

  set<T>(
    documentRef: DocumentReference<T>,
    data: Partial<T>,
    options: PublicSetOptions
  ): WriteBatch;
  set<T>(documentRef: DocumentReference<T>, data: T): WriteBatch;
  set<T>(
    documentRef: PublicDocumentReference<T>,
    value: T | Partial<T>,
    options?: PublicSetOptions
  ): WriteBatch {
    this.verifyNotCommitted();
    const ref = validateReference(
      'WriteBatch.set',
      documentRef,
      this._firestore
    );
    options = validateSetOptions('WriteBatch.set', options);
    const convertedValue = applyFirestoreDataConverter(
      ref._converter,
      value,
      options
    );
    const parsed = parseSetData(
      this._dataReader,
      'WriteBatch.set',
      ref._key,
      convertedValue,
      ref._converter !== null,
      options
    );
    this._mutations = this._mutations.concat(
      parsed.toMutations(ref._key, Precondition.none())
    );
    return this;
  }

  update(
    documentRef: PublicDocumentReference<unknown>,
    value: PublicUpdateData
  ): WriteBatch;
  update(
    documentRef: PublicDocumentReference<unknown>,
    field: string | PublicFieldPath,
    value: unknown,
    ...moreFieldsAndValues: unknown[]
  ): WriteBatch;
  update(
    documentRef: PublicDocumentReference<unknown>,
    fieldOrUpdateData: string | PublicFieldPath | PublicUpdateData,
    value?: unknown,
    ...moreFieldsAndValues: unknown[]
  ): WriteBatch {
    this.verifyNotCommitted();
    const ref = validateReference(
      'WriteBatch.update',
      documentRef,
      this._firestore
    );

    // For Compat types, we have to "extract" the underlying types before
    // performing validation.
    if (fieldOrUpdateData instanceof Compat) {
      fieldOrUpdateData = (fieldOrUpdateData as Compat<ExpFieldPath>)._delegate;
    }

    let parsed;
    if (
      typeof fieldOrUpdateData === 'string' ||
      fieldOrUpdateData instanceof ExpFieldPath
    ) {
      parsed = parseUpdateVarargs(
        this._dataReader,
        'WriteBatch.update',
        ref._key,
        fieldOrUpdateData,
        value,
        moreFieldsAndValues
      );
    } else {
      parsed = parseUpdateData(
        this._dataReader,
        'WriteBatch.update',
        ref._key,
        fieldOrUpdateData
      );
    }

    this._mutations = this._mutations.concat(
      parsed.toMutations(ref._key, Precondition.exists(true))
    );
    return this;
  }

  delete(documentRef: PublicDocumentReference<unknown>): WriteBatch {
    this.verifyNotCommitted();
    const ref = validateReference(
      'WriteBatch.delete',
      documentRef,
      this._firestore
    );
    this._mutations = this._mutations.concat(
      new DeleteMutation(ref._key, Precondition.none())
    );
    return this;
  }

  commit(): Promise<void> {
    this.verifyNotCommitted();
    this._committed = true;
    if (this._mutations.length > 0) {
      const client = ensureFirestoreConfigured(this._firestore._delegate);
      return firestoreClientWrite(client, this._mutations);
    }

    return Promise.resolve();
  }

  private verifyNotCommitted(): void {
    if (this._committed) {
      throw new FirestoreError(
        Code.FAILED_PRECONDITION,
        'A write batch can no longer be used after commit() ' +
          'has been called.'
      );
    }
  }
}

/**
 * A reference to a particular document in a collection in the database.
 */
export class DocumentReference<T = PublicDocumentData>
  extends Compat<ExpDocumentReference<T>>
  implements PublicDocumentReference<T> {
  private _userDataWriter: UserDataWriter;

  constructor(
    readonly firestore: Firestore,
    delegate: ExpDocumentReference<T>
  ) {
    super(delegate);
    this._userDataWriter = new UserDataWriter(firestore);
  }

  static forPath<U>(
    path: ResourcePath,
    firestore: Firestore,
    converter: UntypedFirestoreDataConverter<U> | null
  ): DocumentReference<U> {
    if (path.length % 2 !== 0) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        'Invalid document reference. Document ' +
          'references must have an even number of segments, but ' +
          `${path.canonicalString()} has ${path.length}`
      );
    }
    return new DocumentReference(
      firestore,
      new ExpDocumentReference(
        firestore._delegate,
        converter,
        new DocumentKey(path)
      )
    );
  }

  static forKey<U>(
    key: DocumentKey,
    firestore: Firestore,
    converter: UntypedFirestoreDataConverter<U> | null
  ): DocumentReference<U> {
    return new DocumentReference(
      firestore,
      new ExpDocumentReference(firestore._delegate, converter, key)
    );
  }

  get id(): string {
    return this._delegate.id;
  }

  get parent(): PublicCollectionReference<T> {
    return new CollectionReference(
      this._delegate._path.popLast(),
      this.firestore,
      this._delegate._converter
    );
  }

  get path(): string {
    return this._delegate.path;
  }

  collection(
    pathString: string
  ): PublicCollectionReference<PublicDocumentData> {
    validateNonEmptyArgument(
      'DocumentReference.collection',
      'path',
      pathString
    );
    if (!pathString) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        'Must provide a non-empty collection name to collection()'
      );
    }
    const path = ResourcePath.fromString(pathString);
    return new CollectionReference(
      this._delegate._path.child(path),
      this.firestore,
      /* converter= */ null
    );
  }

  isEqual(other: PublicDocumentReference<T>): boolean {
    if (other instanceof Compat) {
      other = other._delegate;
    }
    if (!(other instanceof ExpDocumentReference)) {
      return false;
    }
    return refEqual(this._delegate, other);
  }

  set(value: Partial<T>, options: PublicSetOptions): Promise<void>;
  set(value: T): Promise<void>;
  set(value: T | Partial<T>, options?: PublicSetOptions): Promise<void> {
    options = validateSetOptions('DocumentReference.set', options);
    try {
      return setDoc(this._delegate, value, options);
    } catch (e) {
      throw replaceFunctionName(e, 'setDoc', 'DocumentReference.set');
    }
  }

  update(value: PublicUpdateData): Promise<void>;
  update(
    field: string | PublicFieldPath,
    value: unknown,
    ...moreFieldsAndValues: unknown[]
  ): Promise<void>;
  update(
    fieldOrUpdateData: string | PublicFieldPath | PublicUpdateData,
    value?: unknown,
    ...moreFieldsAndValues: unknown[]
  ): Promise<void> {
    try {
      if (arguments.length === 1) {
        return updateDoc(this._delegate, fieldOrUpdateData as PublicUpdateData);
      } else {
        return updateDoc(
          this._delegate,
          fieldOrUpdateData as string | ExpFieldPath,
          value,
          ...moreFieldsAndValues
        );
      }
    } catch (e) {
      throw replaceFunctionName(e, 'updateDoc', 'DocumentReference.update');
    }
  }

  delete(): Promise<void> {
    return deleteDoc(this._delegate);
  }

  onSnapshot(observer: PartialObserver<PublicDocumentSnapshot<T>>): Unsubscribe;
  onSnapshot(
    options: PublicSnapshotListenOptions,
    observer: PartialObserver<PublicDocumentSnapshot<T>>
  ): Unsubscribe;
  onSnapshot(
    onNext: NextFn<PublicDocumentSnapshot<T>>,
    onError?: ErrorFn,
    onCompletion?: CompleteFn
  ): Unsubscribe;
  onSnapshot(
    options: PublicSnapshotListenOptions,
    onNext: NextFn<PublicDocumentSnapshot<T>>,
    onError?: ErrorFn,
    onCompletion?: CompleteFn
  ): Unsubscribe;

  onSnapshot(...args: unknown[]): Unsubscribe {
    const options = extractSnapshotOptions(args);
    const observer = wrapObserver<DocumentSnapshot<T>, ExpDocumentSnapshot<T>>(
      args,
      result =>
        new DocumentSnapshot(
          this.firestore,
          new ExpDocumentSnapshot(
            this.firestore._delegate,
            this._userDataWriter,
            result._key,
            result._document,
            result.metadata,
            this._delegate._converter
          )
        )
    );
    return onSnapshot(this._delegate, options, observer);
  }

  get(options?: PublicGetOptions): Promise<PublicDocumentSnapshot<T>> {
    let snap: Promise<ExpDocumentSnapshot<T>>;
    if (options?.source === 'cache') {
      snap = getDocFromCache(this._delegate);
    } else if (options?.source === 'server') {
      snap = getDocFromServer(this._delegate);
    } else {
      snap = getDoc(this._delegate);
    }

    return snap.then(
      result =>
        new DocumentSnapshot(
          this.firestore,
          new ExpDocumentSnapshot(
            this.firestore._delegate,
            this._userDataWriter,
            result._key,
            result._document,
            result.metadata,
            this._delegate._converter as UntypedFirestoreDataConverter<T>
          )
        )
    );
  }

  withConverter<U>(
    converter: PublicFirestoreDataConverter<U>
  ): PublicDocumentReference<U> {
    return new DocumentReference<U>(
      this.firestore,
      this._delegate.withConverter(
        converter as UntypedFirestoreDataConverter<U>
      )
    );
  }
}

/**
 * Replaces the function name in an error thrown by the firestore-exp API
 * with the function names used in the classic API.
 */
function replaceFunctionName(
  e: Error,
  originalFunctionName: string,
  updatedFunctionName: string
): Error {
  e.message = e.message.replace(
    `${originalFunctionName}()`,
    `${updatedFunctionName}()`
  );
  return e;
}

/**
 * Iterates the list of arguments from an `onSnapshot` call and returns the
 * first argument that may be an `SnapshotListenOptions` object. Returns an
 * empty object if none is found.
 */
export function extractSnapshotOptions(
  args: unknown[]
): PublicSnapshotListenOptions {
  for (const arg of args) {
    if (typeof arg === 'object' && !isPartialObserver(arg)) {
      return arg as PublicSnapshotListenOptions;
    }
  }
  return {};
}

/**
 * Creates an observer that can be passed to the firestore-exp SDK. The
 * observer converts all observed values into the format expected by the classic
 * SDK.
 *
 * @param args The list of arguments from an `onSnapshot` call.
 * @param wrapper The function that converts the firestore-exp type into the
 * type used by this shim.
 */
export function wrapObserver<CompatType, ExpType>(
  args: unknown[],
  wrapper: (val: ExpType) => CompatType
): PartialObserver<ExpType> {
  let userObserver: PartialObserver<CompatType>;
  if (isPartialObserver(args[0])) {
    userObserver = args[0] as PartialObserver<CompatType>;
  } else if (isPartialObserver(args[1])) {
    userObserver = args[1];
  } else if (typeof args[0] === 'function') {
    userObserver = {
      next: args[0] as NextFn<CompatType> | undefined,
      error: args[1] as ErrorFn | undefined,
      complete: args[2] as CompleteFn | undefined
    };
  } else {
    userObserver = {
      next: args[1] as NextFn<CompatType> | undefined,
      error: args[2] as ErrorFn | undefined,
      complete: args[3] as CompleteFn | undefined
    };
  }

  return {
    next: val => {
      if (userObserver!.next) {
        userObserver!.next(wrapper(val));
      }
    },
    error: userObserver.error?.bind(userObserver),
    complete: userObserver.complete?.bind(userObserver)
  };
}

/**
 * Metadata about a snapshot, describing the state of the snapshot.
 */
export class SnapshotMetadata implements PublicSnapshotMetadata {
  /**
   * True if the snapshot contains the result of local writes (for example
   * `set()` or `update()` calls) that have not yet been committed to the
   * backend. If your listener has opted into metadata updates (via
   * `SnapshotListenOptions`) you will receive another snapshot with
   * `hasPendingWrites` equal to false once the writes have been committed to
   * the backend.
   */
  readonly hasPendingWrites: boolean;

  /**
   * True if the snapshot was created from cached data rather than guaranteed
   * up-to-date server data. If your listener has opted into metadata updates
   * (via `SnapshotListenOptions`) you will receive another snapshot with
   * `fromCache` set to false once the client has received up-to-date data from
   * the backend.
   */
  readonly fromCache: boolean;

  constructor(hasPendingWrites: boolean, fromCache: boolean) {
    this.hasPendingWrites = hasPendingWrites;
    this.fromCache = fromCache;
  }

  /**
   * Returns true if this `SnapshotMetadata` is equal to the provided one.
   *
   * @param other The `SnapshotMetadata` to compare against.
   * @return true if this `SnapshotMetadata` is equal to the provided one.
   */
  isEqual(other: PublicSnapshotMetadata): boolean {
    return (
      this.hasPendingWrites === other.hasPendingWrites &&
      this.fromCache === other.fromCache
    );
  }
}

/**
 * Options interface that can be provided to configure the deserialization of
 * DocumentSnapshots.
 */
export interface SnapshotOptions extends PublicSnapshotOptions {}

export class DocumentSnapshot<T = PublicDocumentData>
  extends Compat<ExpDocumentSnapshot<T>>
  implements PublicDocumentSnapshot<T> {
  constructor(
    private readonly _firestore: Firestore,
    delegate: ExpDocumentSnapshot<T>
  ) {
    super(delegate);
  }

  get ref(): DocumentReference<T> {
    return new DocumentReference<T>(this._firestore, this._delegate.ref);
  }

  get id(): string {
    return this._delegate.id;
  }

  get metadata(): SnapshotMetadata {
    return this._delegate.metadata;
  }

  get exists(): boolean {
    return this._delegate.exists();
  }

  data(options?: PublicSnapshotOptions): T | undefined {
    return this._delegate.data(options);
  }

  get(
    fieldPath: string | PublicFieldPath,
    options?: PublicSnapshotOptions
    // We are using `any` here to avoid an explicit cast by our users.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    return this._delegate.get(fieldPath as string | ExpFieldPath, options);
  }

  isEqual(other: DocumentSnapshot<T>): boolean {
    return snapshotEqual(this._delegate, other._delegate);
  }
}

export class QueryDocumentSnapshot<T = PublicDocumentData>
  extends DocumentSnapshot<T>
  implements PublicQueryDocumentSnapshot<T> {
  data(options?: PublicSnapshotOptions): T {
    const data = this._delegate.data(options);
    debugAssert(
      data !== undefined,
      'Document in a QueryDocumentSnapshot should exist'
    );
    return data;
  }
}

export function newQueryFilter(
  query: InternalQuery,
  methodName: string,
  dataReader: UserDataReader,
  databaseId: DatabaseId,
  fieldPath: FieldPath,
  op: Operator,
  value: unknown
): FieldFilter {
  let fieldValue: ProtoValue;
  if (fieldPath.isKeyField()) {
    if (op === Operator.ARRAY_CONTAINS || op === Operator.ARRAY_CONTAINS_ANY) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        `Invalid Query. You can't perform '${op}' ` +
          'queries on FieldPath.documentId().'
      );
    } else if (op === Operator.IN || op === Operator.NOT_IN) {
      validateDisjunctiveFilterElements(value, op);
      const referenceList: ProtoValue[] = [];
      for (const arrayValue of value as ProtoValue[]) {
        referenceList.push(parseDocumentIdValue(databaseId, query, arrayValue));
      }
      fieldValue = { arrayValue: { values: referenceList } };
    } else {
      fieldValue = parseDocumentIdValue(databaseId, query, value);
    }
  } else {
    if (
      op === Operator.IN ||
      op === Operator.NOT_IN ||
      op === Operator.ARRAY_CONTAINS_ANY
    ) {
      validateDisjunctiveFilterElements(value, op);
    }
    fieldValue = parseQueryValue(
      dataReader,
      methodName,
      value,
      /* allowArrays= */ op === Operator.IN || op === Operator.NOT_IN
    );
  }
  const filter = FieldFilter.create(fieldPath, op, fieldValue);
  validateNewFilter(query, filter);
  return filter;
}

export function newQueryOrderBy(
  query: InternalQuery,
  fieldPath: FieldPath,
  direction: Direction
): OrderBy {
  if (query.startAt !== null) {
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      'Invalid query. You must not call startAt() or startAfter() before ' +
        'calling orderBy().'
    );
  }
  if (query.endAt !== null) {
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      'Invalid query. You must not call endAt() or endBefore() before ' +
        'calling orderBy().'
    );
  }
  const orderBy = new OrderBy(fieldPath, direction);
  validateNewOrderBy(query, orderBy);
  return orderBy;
}

/**
 * Create a Bound from a query and a document.
 *
 * Note that the Bound will always include the key of the document
 * and so only the provided document will compare equal to the returned
 * position.
 *
 * Will throw if the document does not contain all fields of the order by
 * of the query or if any of the fields in the order by are an uncommitted
 * server timestamp.
 */
export function newQueryBoundFromDocument(
  query: InternalQuery,
  databaseId: DatabaseId,
  methodName: string,
  doc: Document | null,
  before: boolean
): Bound {
  if (!doc) {
    throw new FirestoreError(
      Code.NOT_FOUND,
      `Can't use a DocumentSnapshot that doesn't exist for ` +
        `${methodName}().`
    );
  }

  const components: ProtoValue[] = [];

  // Because people expect to continue/end a query at the exact document
  // provided, we need to use the implicit sort order rather than the explicit
  // sort order, because it's guaranteed to contain the document key. That way
  // the position becomes unambiguous and the query continues/ends exactly at
  // the provided document. Without the key (by using the explicit sort
  // orders), multiple documents could match the position, yielding duplicate
  // results.
  for (const orderBy of queryOrderBy(query)) {
    if (orderBy.field.isKeyField()) {
      components.push(refValue(databaseId, doc.key));
    } else {
      const value = doc.field(orderBy.field);
      if (isServerTimestamp(value)) {
        throw new FirestoreError(
          Code.INVALID_ARGUMENT,
          'Invalid query. You are trying to start or end a query using a ' +
            'document for which the field "' +
            orderBy.field +
            '" is an uncommitted server timestamp. (Since the value of ' +
            'this field is unknown, you cannot start/end a query with it.)'
        );
      } else if (value !== null) {
        components.push(value);
      } else {
        const field = orderBy.field.canonicalString();
        throw new FirestoreError(
          Code.INVALID_ARGUMENT,
          `Invalid query. You are trying to start or end a query using a ` +
            `document for which the field '${field}' (used as the ` +
            `orderBy) does not exist.`
        );
      }
    }
  }
  return new Bound(components, before);
}

/**
 * Converts a list of field values to a Bound for the given query.
 */
export function newQueryBoundFromFields(
  query: InternalQuery,
  databaseId: DatabaseId,
  dataReader: UserDataReader,
  methodName: string,
  values: unknown[],
  before: boolean
): Bound {
  // Use explicit order by's because it has to match the query the user made
  const orderBy = query.explicitOrderBy;
  if (values.length > orderBy.length) {
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      `Too many arguments provided to ${methodName}(). ` +
        `The number of arguments must be less than or equal to the ` +
        `number of orderBy() clauses`
    );
  }

  const components: ProtoValue[] = [];
  for (let i = 0; i < values.length; i++) {
    const rawValue = values[i];
    const orderByComponent = orderBy[i];
    if (orderByComponent.field.isKeyField()) {
      if (typeof rawValue !== 'string') {
        throw new FirestoreError(
          Code.INVALID_ARGUMENT,
          `Invalid query. Expected a string for document ID in ` +
            `${methodName}(), but got a ${typeof rawValue}`
        );
      }
      if (!isCollectionGroupQuery(query) && rawValue.indexOf('/') !== -1) {
        throw new FirestoreError(
          Code.INVALID_ARGUMENT,
          `Invalid query. When querying a collection and ordering by FieldPath.documentId(), ` +
            `the value passed to ${methodName}() must be a plain document ID, but ` +
            `'${rawValue}' contains a slash.`
        );
      }
      const path = query.path.child(ResourcePath.fromString(rawValue));
      if (!DocumentKey.isDocumentKey(path)) {
        throw new FirestoreError(
          Code.INVALID_ARGUMENT,
          `Invalid query. When querying a collection group and ordering by ` +
            `FieldPath.documentId(), the value passed to ${methodName}() must result in a ` +
            `valid document path, but '${path}' is not because it contains an odd number ` +
            `of segments.`
        );
      }
      const key = new DocumentKey(path);
      components.push(refValue(databaseId, key));
    } else {
      const wrapped = parseQueryValue(dataReader, methodName, rawValue);
      components.push(wrapped);
    }
  }

  return new Bound(components, before);
}

/**
 * Parses the given documentIdValue into a ReferenceValue, throwing
 * appropriate errors if the value is anything other than a DocumentReference
 * or String, or if the string is malformed.
 */
function parseDocumentIdValue(
  databaseId: DatabaseId,
  query: InternalQuery,
  documentIdValue: unknown
): ProtoValue {
  if (documentIdValue instanceof Compat) {
    documentIdValue = documentIdValue._delegate;
  }

  if (typeof documentIdValue === 'string') {
    if (documentIdValue === '') {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        'Invalid query. When querying with FieldPath.documentId(), you ' +
          'must provide a valid document ID, but it was an empty string.'
      );
    }
    if (!isCollectionGroupQuery(query) && documentIdValue.indexOf('/') !== -1) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        `Invalid query. When querying a collection by ` +
          `FieldPath.documentId(), you must provide a plain document ID, but ` +
          `'${documentIdValue}' contains a '/' character.`
      );
    }
    const path = query.path.child(ResourcePath.fromString(documentIdValue));
    if (!DocumentKey.isDocumentKey(path)) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        `Invalid query. When querying a collection group by ` +
          `FieldPath.documentId(), the value provided must result in a valid document path, ` +
          `but '${path}' is not because it has an odd number of segments (${path.length}).`
      );
    }
    return refValue(databaseId, new DocumentKey(path));
  } else if (documentIdValue instanceof ExpDocumentReference) {
    return refValue(databaseId, documentIdValue._key);
  } else {
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      `Invalid query. When querying with FieldPath.documentId(), you must provide a valid ` +
        `string or a DocumentReference, but it was: ` +
        `${valueDescription(documentIdValue)}.`
    );
  }
}

/**
 * Validates that the value passed into a disjunctive filter satisfies all
 * array requirements.
 */
function validateDisjunctiveFilterElements(
  value: unknown,
  operator: Operator
): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      'Invalid Query. A non-empty array is required for ' +
        `'${operator.toString()}' filters.`
    );
  }
  if (value.length > 10) {
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      `Invalid Query. '${operator.toString()}' filters support a ` +
        'maximum of 10 elements in the value array.'
    );
  }
}

/**
 * Given an operator, returns the set of operators that cannot be used with it.
 *
 * Operators in a query must adhere to the following set of rules:
 * 1. Only one array operator is allowed.
 * 2. Only one disjunctive operator is allowed.
 * 3. NOT_EQUAL cannot be used with another NOT_EQUAL operator.
 * 4. NOT_IN cannot be used with array, disjunctive, or NOT_EQUAL operators.
 *
 * Array operators: ARRAY_CONTAINS, ARRAY_CONTAINS_ANY
 * Disjunctive operators: IN, ARRAY_CONTAINS_ANY, NOT_IN
 */
function conflictingOps(op: Operator): Operator[] {
  switch (op) {
    case Operator.NOT_EQUAL:
      return [Operator.NOT_EQUAL, Operator.NOT_IN];
    case Operator.ARRAY_CONTAINS:
      return [
        Operator.ARRAY_CONTAINS,
        Operator.ARRAY_CONTAINS_ANY,
        Operator.NOT_IN
      ];
    case Operator.IN:
      return [Operator.ARRAY_CONTAINS_ANY, Operator.IN, Operator.NOT_IN];
    case Operator.ARRAY_CONTAINS_ANY:
      return [
        Operator.ARRAY_CONTAINS,
        Operator.ARRAY_CONTAINS_ANY,
        Operator.IN,
        Operator.NOT_IN
      ];
    case Operator.NOT_IN:
      return [
        Operator.ARRAY_CONTAINS,
        Operator.ARRAY_CONTAINS_ANY,
        Operator.IN,
        Operator.NOT_IN,
        Operator.NOT_EQUAL
      ];
    default:
      return [];
  }
}

function validateNewFilter(query: InternalQuery, filter: Filter): void {
  debugAssert(filter instanceof FieldFilter, 'Only FieldFilters are supported');

  if (filter.isInequality()) {
    const existingField = getInequalityFilterField(query);
    if (existingField !== null && !existingField.isEqual(filter.field)) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        'Invalid query. All where filters with an inequality' +
          ' (<, <=, >, or >=) must be on the same field. But you have' +
          ` inequality filters on '${existingField.toString()}'` +
          ` and '${filter.field.toString()}'`
      );
    }

    const firstOrderByField = getFirstOrderByField(query);
    if (firstOrderByField !== null) {
      validateOrderByAndInequalityMatch(query, filter.field, firstOrderByField);
    }
  }

  const conflictingOp = findFilterOperator(query, conflictingOps(filter.op));
  if (conflictingOp !== null) {
    // Special case when it's a duplicate op to give a slightly clearer error message.
    if (conflictingOp === filter.op) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        'Invalid query. You cannot use more than one ' +
          `'${filter.op.toString()}' filter.`
      );
    } else {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        `Invalid query. You cannot use '${filter.op.toString()}' filters ` +
          `with '${conflictingOp.toString()}' filters.`
      );
    }
  }
}

function validateNewOrderBy(query: InternalQuery, orderBy: OrderBy): void {
  if (getFirstOrderByField(query) === null) {
    // This is the first order by. It must match any inequality.
    const inequalityField = getInequalityFilterField(query);
    if (inequalityField !== null) {
      validateOrderByAndInequalityMatch(query, inequalityField, orderBy.field);
    }
  }
}

function validateOrderByAndInequalityMatch(
  baseQuery: InternalQuery,
  inequality: FieldPath,
  orderBy: FieldPath
): void {
  if (!orderBy.isEqual(inequality)) {
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      `Invalid query. You have a where filter with an inequality ` +
        `(<, <=, >, or >=) on field '${inequality.toString()}' ` +
        `and so you must also use '${inequality.toString()}' ` +
        `as your first orderBy(), but your first orderBy() ` +
        `is on field '${orderBy.toString()}' instead.`
    );
  }
}

export function validateHasExplicitOrderByForLimitToLast(
  query: InternalQuery
): void {
  if (hasLimitToLast(query) && query.explicitOrderBy.length === 0) {
    throw new FirestoreError(
      Code.UNIMPLEMENTED,
      'limitToLast() queries require specifying at least one orderBy() clause'
    );
  }
}

export class Query<T = PublicDocumentData> implements PublicQuery<T> {
  private _dataReader: UserDataReader;

  constructor(
    public _query: InternalQuery,
    readonly firestore: Firestore,
    protected readonly _converter: PublicFirestoreDataConverter<T> | null
  ) {
    this._dataReader = newUserDataReader(firestore._delegate);
  }

  where(
    field: string | PublicFieldPath,
    opStr: PublicWhereFilterOp,
    value: unknown
  ): PublicQuery<T> {
    const fieldPath = fieldPathFromArgument('Query.where', field);
    const filter = newQueryFilter(
      this._query,
      'Query.where',
      this._dataReader,
      this.firestore._databaseId,
      fieldPath,
      opStr as Operator,
      value
    );
    return new Query(
      queryWithAddedFilter(this._query, filter),
      this.firestore,
      this._converter
    );
  }

  orderBy(
    field: string | PublicFieldPath,
    directionStr?: PublicOrderByDirection
  ): PublicQuery<T> {
    let direction: Direction;
    if (directionStr === undefined || directionStr === 'asc') {
      direction = Direction.ASCENDING;
    } else if (directionStr === 'desc') {
      direction = Direction.DESCENDING;
    } else {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        `Function Query.orderBy() has unknown direction '${directionStr}', ` +
          `expected 'asc' or 'desc'.`
      );
    }
    const fieldPath = fieldPathFromArgument('Query.orderBy', field);
    const orderBy = newQueryOrderBy(this._query, fieldPath, direction);
    return new Query(
      queryWithAddedOrderBy(this._query, orderBy),
      this.firestore,
      this._converter
    );
  }

  limit(n: number): PublicQuery<T> {
    validatePositiveNumber('Query.limit', n);
    return new Query(
      queryWithLimit(this._query, n, LimitType.First),
      this.firestore,
      this._converter
    );
  }

  limitToLast(n: number): PublicQuery<T> {
    validatePositiveNumber('Query.limitToLast', n);
    return new Query(
      queryWithLimit(this._query, n, LimitType.Last),
      this.firestore,
      this._converter
    );
  }

  startAt(
    docOrField: unknown | PublicDocumentSnapshot<unknown>,
    ...fields: unknown[]
  ): PublicQuery<T> {
    const bound = this.boundFromDocOrFields(
      'Query.startAt',
      docOrField,
      fields,
      /*before=*/ true
    );
    return new Query(
      queryWithStartAt(this._query, bound),
      this.firestore,
      this._converter
    );
  }

  startAfter(
    docOrField: unknown | PublicDocumentSnapshot<unknown>,
    ...fields: unknown[]
  ): PublicQuery<T> {
    const bound = this.boundFromDocOrFields(
      'Query.startAfter',
      docOrField,
      fields,
      /*before=*/ false
    );
    return new Query(
      queryWithStartAt(this._query, bound),
      this.firestore,
      this._converter
    );
  }

  endBefore(
    docOrField: unknown | PublicDocumentSnapshot<unknown>,
    ...fields: unknown[]
  ): PublicQuery<T> {
    const bound = this.boundFromDocOrFields(
      'Query.endBefore',
      docOrField,
      fields,
      /*before=*/ true
    );
    return new Query(
      queryWithEndAt(this._query, bound),
      this.firestore,
      this._converter
    );
  }

  endAt(
    docOrField: unknown | PublicDocumentSnapshot<unknown>,
    ...fields: unknown[]
  ): PublicQuery<T> {
    const bound = this.boundFromDocOrFields(
      'Query.endAt',
      docOrField,
      fields,
      /*before=*/ false
    );
    return new Query(
      queryWithEndAt(this._query, bound),
      this.firestore,
      this._converter
    );
  }

  isEqual(other: PublicQuery<T>): boolean {
    if (!(other instanceof Query)) {
      return false;
    }
    return (
      this.firestore === other.firestore &&
      queryEquals(this._query, other._query) &&
      this._converter === other._converter
    );
  }

  withConverter<U>(converter: PublicFirestoreDataConverter<U>): PublicQuery<U> {
    return new Query<U>(this._query, this.firestore, converter);
  }

  /** Helper function to create a bound from a document or fields */
  private boundFromDocOrFields(
    methodName: string,
    docOrField: unknown | PublicDocumentSnapshot<T>,
    fields: unknown[],
    before: boolean
  ): Bound {
    if (docOrField instanceof DocumentSnapshot) {
      return newQueryBoundFromDocument(
        this._query,
        this.firestore._databaseId,
        methodName,
        docOrField._delegate._document,
        before
      );
    } else {
      const allFields = [docOrField].concat(fields);
      return newQueryBoundFromFields(
        this._query,
        this.firestore._databaseId,
        this._dataReader,
        methodName,
        allFields,
        before
      );
    }
  }

  onSnapshot(observer: PartialObserver<PublicQuerySnapshot<T>>): Unsubscribe;
  onSnapshot(
    options: PublicSnapshotListenOptions,
    observer: PartialObserver<PublicQuerySnapshot<T>>
  ): Unsubscribe;
  onSnapshot(
    onNext: NextFn<PublicQuerySnapshot<T>>,
    onError?: ErrorFn,
    onCompletion?: CompleteFn
  ): Unsubscribe;
  onSnapshot(
    options: PublicSnapshotListenOptions,
    onNext: NextFn<PublicQuerySnapshot<T>>,
    onError?: ErrorFn,
    onCompletion?: CompleteFn
  ): Unsubscribe;

  onSnapshot(...args: unknown[]): Unsubscribe {
    let options: ListenOptions = {};
    let currArg = 0;
    if (
      typeof args[currArg] === 'object' &&
      !isPartialObserver(args[currArg])
    ) {
      options = args[currArg] as PublicSnapshotListenOptions;
      currArg++;
    }

    if (isPartialObserver(args[currArg])) {
      const userObserver = args[currArg] as PartialObserver<
        PublicQuerySnapshot<T>
      >;
      args[currArg] = userObserver.next?.bind(userObserver);
      args[currArg + 1] = userObserver.error?.bind(userObserver);
      args[currArg + 2] = userObserver.complete?.bind(userObserver);
    } else {
    }

    const observer: PartialObserver<ViewSnapshot> = {
      next: snapshot => {
        if (args[currArg]) {
          (args[currArg] as NextFn<PublicQuerySnapshot<T>>)(
            new QuerySnapshot(
              this.firestore,
              this._query,
              snapshot,
              this._converter
            )
          );
        }
      },
      error: args[currArg + 1] as ErrorFn,
      complete: args[currArg + 2] as CompleteFn
    };

    validateHasExplicitOrderByForLimitToLast(this._query);
    const client = ensureFirestoreConfigured(this.firestore._delegate);
    return firestoreClientListen(client, this._query, options, observer);
  }

  get(options?: PublicGetOptions): Promise<PublicQuerySnapshot<T>> {
    validateHasExplicitOrderByForLimitToLast(this._query);

    const client = ensureFirestoreConfigured(this.firestore._delegate);
    return (options && options.source === 'cache'
      ? firestoreClientGetDocumentsFromLocalCache(client, this._query)
      : firestoreClientGetDocumentsViaSnapshotListener(
          client,
          this._query,
          options
        )
    ).then(
      snap =>
        new QuerySnapshot(this.firestore, this._query, snap, this._converter)
    );
  }
}

export class QuerySnapshot<T = PublicDocumentData>
  implements PublicQuerySnapshot<T> {
  private _cachedChanges: Array<PublicDocumentChange<T>> | null = null;
  private _cachedChangesIncludeMetadataChanges: boolean | null = null;
  private _userDataWriter: UserDataWriter;

  readonly metadata: PublicSnapshotMetadata;

  constructor(
    private readonly _firestore: Firestore,
    private readonly _originalQuery: InternalQuery,
    private readonly _snapshot: ViewSnapshot,
    private readonly _converter: PublicFirestoreDataConverter<T> | null
  ) {
    this._userDataWriter = new UserDataWriter(this._firestore);
    this.metadata = new SnapshotMetadata(
      _snapshot.hasPendingWrites,
      _snapshot.fromCache
    );
  }

  get docs(): Array<PublicQueryDocumentSnapshot<T>> {
    const result: Array<PublicQueryDocumentSnapshot<T>> = [];
    this.forEach(doc => result.push(doc));
    return result;
  }

  get empty(): boolean {
    return this._snapshot.docs.isEmpty();
  }

  get size(): number {
    return this._snapshot.docs.size;
  }

  forEach(
    callback: (result: PublicQueryDocumentSnapshot<T>) => void,
    thisArg?: unknown
  ): void {
    this._snapshot.docs.forEach(doc => {
      callback.call(
        thisArg,
        this.convertToDocumentImpl(
          doc,
          this.metadata.fromCache,
          this._snapshot.mutatedKeys.has(doc.key)
        )
      );
    });
  }

  get query(): PublicQuery<T> {
    return new Query(this._originalQuery, this._firestore, this._converter);
  }

  docChanges(
    options?: PublicSnapshotListenOptions
  ): Array<PublicDocumentChange<T>> {
    if (options) {
    }

    const includeMetadataChanges = !!(
      options && options.includeMetadataChanges
    );

    if (includeMetadataChanges && this._snapshot.excludesMetadataChanges) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        'To include metadata changes with your document changes, you must ' +
          'also pass { includeMetadataChanges:true } to onSnapshot().'
      );
    }

    if (
      !this._cachedChanges ||
      this._cachedChangesIncludeMetadataChanges !== includeMetadataChanges
    ) {
      this._cachedChanges = changesFromSnapshot<QueryDocumentSnapshot<T>>(
        this._snapshot,
        includeMetadataChanges,
        this.convertToDocumentImpl.bind(this)
      );
      this._cachedChangesIncludeMetadataChanges = includeMetadataChanges;
    }

    return this._cachedChanges;
  }

  /** Check the equality. The call can be very expensive. */
  isEqual(other: PublicQuerySnapshot<T>): boolean {
    if (!(other instanceof QuerySnapshot)) {
      return false;
    }

    return (
      this._firestore === other._firestore &&
      queryEquals(this._originalQuery, other._originalQuery) &&
      this._snapshot.isEqual(other._snapshot) &&
      this._converter === other._converter
    );
  }

  private convertToDocumentImpl(
    doc: Document,
    fromCache: boolean,
    hasPendingWrites: boolean
  ): QueryDocumentSnapshot<T> {
    return new QueryDocumentSnapshot(
      this._firestore,
      new ExpQueryDocumentSnapshot(
        this._firestore._delegate,
        this._userDataWriter,
        doc.key,
        doc,
        new SnapshotMetadata(hasPendingWrites, fromCache),
        this._converter
      )
    );
  }
}

export class CollectionReference<T = PublicDocumentData>
  extends Query<T>
  implements PublicCollectionReference<T> {
  constructor(
    readonly _path: ResourcePath,
    firestore: Firestore,
    _converter: UntypedFirestoreDataConverter<T> | null
  ) {
    super(newQueryForPath(_path), firestore, _converter);
    if (_path.length % 2 !== 1) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        'Invalid collection reference. Collection ' +
          'references must have an odd number of segments, but ' +
          `${_path.canonicalString()} has ${_path.length}`
      );
    }
  }

  get id(): string {
    return this._query.path.lastSegment();
  }

  get parent(): PublicDocumentReference<PublicDocumentData> | null {
    const parentPath = this._query.path.popLast();
    if (parentPath.isEmpty()) {
      return null;
    } else {
      return DocumentReference.forPath(
        parentPath,
        this.firestore,
        /* converter= */ null
      );
    }
  }

  get path(): string {
    return this._query.path.canonicalString();
  }

  doc(pathString?: string): PublicDocumentReference<T> {
    // We allow omission of 'pathString' but explicitly prohibit passing in both
    // 'undefined' and 'null'.
    if (arguments.length === 0) {
      pathString = AutoId.newId();
    }
    validateNonEmptyArgument('CollectionReference.doc', 'path', pathString);
    const path = ResourcePath.fromString(pathString!);
    return DocumentReference.forPath<T>(
      this._query.path.child(path),
      this.firestore,
      this._converter
    );
  }

  add(value: T): Promise<PublicDocumentReference<T>> {
    const convertedValue = this._converter
      ? this._converter.toFirestore(value)
      : value;
    const docRef = this.doc();

    // Call set() with the converted value directly to avoid calling toFirestore() a second time.
    return DocumentReference.forKey(
      (docRef as DocumentReference<T>)._delegate._key,
      this.firestore,
      null
    )
      .set(convertedValue)
      .then(() => docRef);
  }

  withConverter<U>(
    converter: PublicFirestoreDataConverter<U>
  ): PublicCollectionReference<U> {
    return new CollectionReference<U>(this._path, this.firestore, converter);
  }
}

function validateReference<T>(
  methodName: string,
  documentRef: PublicDocumentReference<T>,
  firestore: Firestore
): ExpDocumentReference<T> {
  const reference = cast<ExpDocumentReference<T>>(
    documentRef,
    ExpDocumentReference
  );
  if (reference.firestore !== firestore._delegate) {
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      'Provided document reference is from a different Firestore instance.'
    );
  } else {
    return reference;
  }
}

/**
 * Calculates the array of DocumentChanges for a given ViewSnapshot.
 *
 * Exported for testing.
 *
 * @param snapshot The ViewSnapshot that represents the expected state.
 * @param includeMetadataChanges Whether to include metadata changes.
 * @param converter A factory function that returns a QueryDocumentSnapshot.
 * @return An object that matches the DocumentChange API.
 */
export function changesFromSnapshot<DocSnap>(
  snapshot: ViewSnapshot,
  includeMetadataChanges: boolean,
  converter: (
    doc: Document,
    fromCache: boolean,
    hasPendingWrite: boolean
  ) => DocSnap
): Array<{
  type: PublicDocumentChangeType;
  doc: DocSnap;
  oldIndex: number;
  newIndex: number;
}> {
  if (snapshot.oldDocs.isEmpty()) {
    // Special case the first snapshot because index calculation is easy and
    // fast
    let lastDoc: Document;
    let index = 0;
    return snapshot.docChanges.map(change => {
      const doc = converter(
        change.doc,
        snapshot.fromCache,
        snapshot.mutatedKeys.has(change.doc.key)
      );
      debugAssert(
        change.type === ChangeType.Added,
        'Invalid event type for first snapshot'
      );
      debugAssert(
        !lastDoc || newQueryComparator(snapshot.query)(lastDoc, change.doc) < 0,
        'Got added events in wrong order'
      );
      lastDoc = change.doc;
      return {
        type: 'added' as PublicDocumentChangeType,
        doc,
        oldIndex: -1,
        newIndex: index++
      };
    });
  } else {
    // A DocumentSet that is updated incrementally as changes are applied to use
    // to lookup the index of a document.
    let indexTracker = snapshot.oldDocs;
    return snapshot.docChanges
      .filter(
        change => includeMetadataChanges || change.type !== ChangeType.Metadata
      )
      .map(change => {
        const doc = converter(
          change.doc,
          snapshot.fromCache,
          snapshot.mutatedKeys.has(change.doc.key)
        );
        let oldIndex = -1;
        let newIndex = -1;
        if (change.type !== ChangeType.Added) {
          oldIndex = indexTracker.indexOf(change.doc.key);
          debugAssert(oldIndex >= 0, 'Index for document not found');
          indexTracker = indexTracker.delete(change.doc.key);
        }
        if (change.type !== ChangeType.Removed) {
          indexTracker = indexTracker.add(change.doc);
          newIndex = indexTracker.indexOf(change.doc.key);
        }
        return { type: resultChangeType(change.type), doc, oldIndex, newIndex };
      });
  }
}

function resultChangeType(type: ChangeType): PublicDocumentChangeType {
  switch (type) {
    case ChangeType.Added:
      return 'added';
    case ChangeType.Modified:
    case ChangeType.Metadata:
      return 'modified';
    case ChangeType.Removed:
      return 'removed';
    default:
      return fail('Unknown change type: ' + type);
  }
}

/**
 * Converts custom model object of type T into DocumentData by applying the
 * converter if it exists.
 *
 * This function is used when converting user objects to DocumentData
 * because we want to provide the user with a more specific error message if
 * their set() or fails due to invalid data originating from a toFirestore()
 * call.
 */
export function applyFirestoreDataConverter<T>(
  converter: UntypedFirestoreDataConverter<T> | null,
  value: T,
  options?: PublicSetOptions
): PublicDocumentData {
  let convertedValue;
  if (converter) {
    if (options && (options.merge || options.mergeFields)) {
      // Cast to `any` in order to satisfy the union type constraint on
      // toFirestore().
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      convertedValue = (converter as any).toFirestore(value, options);
    } else {
      convertedValue = converter.toFirestore(value);
    }
  } else {
    convertedValue = value as PublicDocumentData;
  }
  return convertedValue;
}
