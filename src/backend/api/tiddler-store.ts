import { inject, injectable, interfaces } from "inversify";
import {
  Tiddler,
  TiddlerData,
  TiddlerNamespace,
} from "../../shared/model/tiddler";
import { NamespacedRecipe } from "../../shared/model/recipe";
import { getRevision, Revision } from "../../shared/model/revision";
import { User } from "../../shared/model/user";
import { Component } from "../common/ioc/components";
import {
  MaybePromise,
  TiddlerPersistence,
  TransactionRunner,
} from "../common/persistence/interfaces";
import { HTTPError, HTTP_BAD_REQUEST, HTTP_FORBIDDEN, HTTP_NOT_FOUND } from "./errors";
import { PolicyChecker } from "./policy-checker";
import { RecipeResolver } from "./recipe-resolver";
import { getTimestamp as _getTimestamp } from "../../shared/util/time";
import { TiddlerFactory } from "../common/tiddler-factory";
import { mapOrApply } from "../../shared/util/map";
import {
  NamespacedTiddler,
  SingleWikiNamespacedTiddler,
  TiddlerUpdateOrCreate,
  BoundTiddlerStore,
  getTiddlerData,
  getExpectedRevision,
} from "../../shared/model/store";
import { MaybeArray } from "../../shared/util/useful-types";

@injectable()
export class GlobalTiddlerStore {
  private transactionRunner: TransactionRunner;
  private policyChecker: PolicyChecker;
  private recipeResolver: RecipeResolver;
  private getTimestamp: typeof _getTimestamp;
  private tiddlerFactory: TiddlerFactory;

  private deduplicate(
    tiddlers: {
      namespace: TiddlerNamespace;
      title: string;
      value: Tiddler;
      revision: string;
    }[]
  ): {
    namespace: TiddlerNamespace;
    title: string;
    value: Tiddler;
    revision: string;
  }[] {
    const encounteredTitles = new Set<string>();
    const deduplicated: {
      namespace: TiddlerNamespace;
      title: string;
      value: Tiddler;
      revision: string;
    }[] = [];
    for (let tiddler of tiddlers) {
      if (encounteredTitles.has(tiddler.title)) {
        continue;
      }
      deduplicated.push(tiddler);
    }
    return deduplicated;
  }

  private getFirst(
    tiddlers: {
      namespace: TiddlerNamespace;
      title: string;
      value: Tiddler;
      revision: string;
    }[],
    title: string
  ):
    | {
        namespace: TiddlerNamespace;
        title: string;
        value: Tiddler;
        revision: string;
      }
    | undefined {
    return tiddlers.find((t) => t.title === title);
  }

  private getUpdater(
    user: User,
    title: string,
    updateOrCreate: TiddlerUpdateOrCreate
  ) {
    return (existingTiddler?: Tiddler): Tiddler => {
      let result:Tiddler;
      if ("update" in updateOrCreate) {
        if (!existingTiddler) {
          throw new HTTPError(
            `Tiddler ${title} received update, but no such tiddler exists in bag`,
            HTTP_BAD_REQUEST
          );
        }
        result = Object.assign({}, existingTiddler, updateOrCreate.update);
      } else {
        result = this.tiddlerFactory.createTiddler(
          user,
          title,
          updateOrCreate.create.type,
          updateOrCreate.create
        );
      }
      return result;
    };
  }

  constructor(
    @inject(Component.TransactionRunner) transactionRunner: TransactionRunner,
    @inject(Component.PolicyChecker) policyChecker: PolicyChecker,
    @inject(Component.RecipeResolver) recipeResolver: RecipeResolver,
    @inject(Component.getTimestamp) getTimestamp: typeof _getTimestamp,
    @inject(Component.TiddlerFactory) tiddlerFactory: TiddlerFactory
  ) {
    this.transactionRunner = transactionRunner;
    this.policyChecker = policyChecker;
    this.recipeResolver = recipeResolver;
    this.getTimestamp = getTimestamp;
    this.tiddlerFactory = tiddlerFactory;
  }

  async readFromBag(
    user: User,
    namespace: TiddlerNamespace,
    title?: string
  ): Promise<NamespacedTiddler | Array<NamespacedTiddler>> {
    return this.transactionRunner.runTransaction(
      user,
      async (persistence: TiddlerPersistence) => {
        const readPermission = await this.policyChecker.verifyReadAccess(
          persistence,
          user,
          namespace.wiki,
          [namespace.bag]
        );
        if (readPermission[0].allowed) {
          const tiddlers = await (title
            ? persistence.readDocs([{ namespace, title }])
            : persistence.readCollections([namespace]));
          if (title) {
            // unpack array if specific tiddler requested
            if (tiddlers.length < 1) {
              throw new HTTPError(
                `Tiddler ${title} not found in wiki ${namespace.wiki} bag ${namespace.bag}`,
                HTTP_NOT_FOUND
              );
            }
            return tiddlers[0];
          }
          return tiddlers;
        }
        throw new HTTPError(
          `Tiddler read denied ${readPermission[0].reason || ""}`,
          HTTP_FORBIDDEN
        );
      }
    );
  }

  async readFromRecipe(
    user: User,
    namespacedRecipe: NamespacedRecipe,
    title?: string
  ): Promise<MaybeArray<NamespacedTiddler>> {
    return this.transactionRunner.runTransaction(
      user,
      async (persistence: TiddlerPersistence) => {
        const bags = await this.recipeResolver.getRecipeBags(
          user,
          "read",
          persistence,
          namespacedRecipe
        );
        if (!bags) {
          throw new HTTPError(
            `Recipe ${namespacedRecipe.recipe} not found in wiki ${namespacedRecipe.wiki}`,
            HTTP_NOT_FOUND
          );
        }
        const readPermissions = await this.policyChecker.verifyReadAccess(
          persistence,
          user,
          namespacedRecipe.wiki,
          bags
        );
        if (!readPermissions.every((p) => p.allowed)) {
          // In the future, we may want to ignore some bags not being readable, and just serve tiddlers from those accessible.
          throw new HTTPError(
            `At least one bag referenced by recipe ${
              namespacedRecipe.recipe
            } in wiki ${
              namespacedRecipe.wiki
            } is not readable. Errors: ${readPermissions
              .map((p) => p.reason)
              .filter((x) => x)
              .join(", ")}`,
            HTTP_NOT_FOUND
          );
        }
        const tiddlers = await persistence.readCollections(
          bags.map((bag) => ({ wiki: namespacedRecipe.wiki, bag }))
        );
        if (title) {
          const tiddler = this.getFirst(tiddlers, title);
          if (!tiddler) {
            throw new HTTPError(
              `Tiddler ${title} not found in wiki ${namespacedRecipe.wiki} recipe ${namespacedRecipe.recipe}`,
              HTTP_NOT_FOUND
            );
          }
          return tiddler;
        } else {
          return this.deduplicate(tiddlers);
        }
      }
    );
  }

  async writeToBag(
    user: User,
    namespace: TiddlerNamespace,
    title: string,
    updateOrCreate: TiddlerUpdateOrCreate
  ): Promise<{
    namespace: TiddlerNamespace;
    title: string;
    value: Tiddler;
    revision: string;
  }> {
    const txResult = await this.transactionRunner.runTransaction(
      user,
      async (persistence: TiddlerPersistence) => {
        const writePermission = await this.policyChecker.getWriteableBag(
          persistence,
          user,
          namespace.wiki,
          [namespace.bag],
          title,
          getTiddlerData(updateOrCreate)
        );
        if (writePermission[0].allowed) {
          return persistence.updateDoc(
            namespace,
            title,
            this.getUpdater(user, title, updateOrCreate),
            getExpectedRevision(updateOrCreate)
          );
        }
        throw new HTTPError(
          `Tiddler write denied ${writePermission[0].reason || ""}`,
          HTTP_FORBIDDEN
        );
      }
    );
    if (!txResult) {
      throw new Error("Result of write transaction should not be null");
    }
    return txResult;
  }

  async writeToRecipe(
    user: User,
    namespacedRecipe: NamespacedRecipe,
    title: string,
    updateOrCreate: TiddlerUpdateOrCreate
  ): Promise<{
    namespace: TiddlerNamespace;
    title: string;
    value: Tiddler;
    revision: string;
  }> {
    const txResult = await this.transactionRunner.runTransaction(
      user,
      async (persistence: TiddlerPersistence) => {
        const bags = await this.recipeResolver.getRecipeBags(
          user,
          "write",
          persistence,
          namespacedRecipe
        );
        if (!bags) {
          throw new HTTPError(
            `Recipe ${namespacedRecipe.recipe} not found in wiki ${namespacedRecipe.wiki}`,
            HTTP_NOT_FOUND
          );
        }
        // find first bag which we can write to
        const permissions = await this.policyChecker.getWriteableBag(
          persistence,
          user,
          namespacedRecipe.wiki,
          bags,
          title,
          getTiddlerData(updateOrCreate)
        );
        const bagToWrite = permissions.find((p) => p.allowed === true);
        if (!bagToWrite) {
          throw new HTTPError(
            `No bags in wiki ${namespacedRecipe.wiki} recipe ${
              namespacedRecipe.recipe
            } found which can be written to. Errors: ${permissions
              .filter((p) => p.reason)
              .map((p) => p.reason)
              .join(", ")}`,
            HTTP_FORBIDDEN
          );
        }
        return persistence.updateDoc(
          { wiki: namespacedRecipe.wiki, bag: bagToWrite.bag },
          title,
          this.getUpdater(user, title, updateOrCreate),
          getExpectedRevision(updateOrCreate)
        );
      }
    );
    return txResult!;
  }

  async removeFromBag(
    user: User,
    namespace: TiddlerNamespace,
    title: string,
    expectedRevision: Revision
  ): Promise<boolean> {
    let tiddlerExisted = false;
    await this.transactionRunner.runTransaction(
      user,
      async (persistence: TiddlerPersistence) => {
        const writePermission = await this.policyChecker.verifyRemoveAccess(
          persistence,
          user,
          namespace.wiki,
          [namespace.bag]
        );
        if (writePermission[0].allowed) {
          const updater = (
            tiddler?: Tiddler
          ): MaybePromise<Tiddler | undefined> => {
            tiddlerExisted = tiddler !== undefined;
            return undefined;
          };
          return persistence.updateDoc(
            namespace,
            title,
            updater,
            expectedRevision
          );
        }
        throw new HTTPError(
          `Tiddler remove denied ${writePermission[0].reason || ""}`,
          HTTP_FORBIDDEN
        );
      }
    );
    return tiddlerExisted;
  }
}
/**
 * Binds user and wiki for a tiddlerstore
 */

const asBoundTiddler = (
  namespacedTiddler: NamespacedTiddler
): SingleWikiNamespacedTiddler => ({
  bag: namespacedTiddler.namespace.bag,
  tiddler: namespacedTiddler.value,
  revision: namespacedTiddler.revision,
});

export class BoundTiddlerStoreImpl implements BoundTiddlerStore {
  private user: User;
  private wiki: string;
  private tiddlerStore: GlobalTiddlerStore;

  constructor(user: User, wiki: string, tiddlerStore: GlobalTiddlerStore) {
    this.user = user;
    this.wiki = wiki;
    this.tiddlerStore = tiddlerStore;
  }

  removeFromBag(
    bag: string,
    title: string,
    expectedRevision: Revision
  ): Promise<boolean> {
    return this.tiddlerStore.removeFromBag(
      this.user,
      { wiki: this.wiki, bag },
      title,
      expectedRevision
    );
  }

  async writeToRecipe(
    recipe: string,
    title: string,
    updateOrCreate: TiddlerUpdateOrCreate
  ): Promise<SingleWikiNamespacedTiddler> {
    return asBoundTiddler(
      await this.tiddlerStore.writeToRecipe(
        this.user,
        { wiki: this.wiki, recipe },
        title,
        updateOrCreate
      )
    );
  }

  async writeToBag(
    bag: string,
    title: string,
    updateOrCreate: TiddlerUpdateOrCreate
  ): Promise<SingleWikiNamespacedTiddler> {
    return asBoundTiddler(
      await this.tiddlerStore.writeToBag(
        this.user,
        { wiki: this.wiki, bag },
        title,
        updateOrCreate
      )
    );
  }

  async readFromRecipe(
    recipe: string,
    title?: string
  ): Promise<SingleWikiNamespacedTiddler | Array<SingleWikiNamespacedTiddler>> {
    return mapOrApply(
      asBoundTiddler,
      await this.tiddlerStore.readFromRecipe(
        this.user,
        { wiki: this.wiki, recipe },
        title
      )
    );
  }

  async readFromBag(
    bag: string,
    title?: string
  ): Promise<SingleWikiNamespacedTiddler | Array<SingleWikiNamespacedTiddler>> {
    return mapOrApply(
      asBoundTiddler,
      await this.tiddlerStore.readFromBag(
        this.user,
        { wiki: this.wiki, bag },
        title
      )
    );
  }
}

export const injectableBoundTiddlerStoreFactory = (
  context: interfaces.Context
) => (user: User, wiki: string) => {
  const tiddlerStore = context.container.get<GlobalTiddlerStore>(
    Component.GlobalTiddlerStore
  );
  return new BoundTiddlerStoreImpl(user, wiki, tiddlerStore);
};

export type BoundTiddlerStoreFactory = ReturnType<
  typeof injectableBoundTiddlerStoreFactory
>;
