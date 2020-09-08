/**
 * @license
 * Copyright 2019 Google LLC
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

/**
 * A Firebase Installation instance which is a required argument for all Firebase Installations operations.
 *
 * @public
 */
export interface FirebaseInstallations {}

/**
 * An interface for Firebase internal SDKs use only.
 *
 * @internal
 */
export interface _FirebaseInstallationsInternal {
  /**
   * Creates a Firebase Installation if there isn't one for the app and
   * returns the Installation ID.
   */
  getId(): Promise<string>;

  /**
   * Returns an Authentication Token for the current Firebase Installation.
   */
  getToken(forceRefresh?: boolean): Promise<string>;
}

declare module '@firebase/component' {
  interface NameServiceMapping {
    'installations-exp': FirebaseInstallations;
    'installations-exp-internal': _FirebaseInstallationsInternal;
  }
}