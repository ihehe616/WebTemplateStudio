import * as vscode from "vscode";
import { MICROSOFT_LEARN_TENANTS } from './../configuration.json';

import {
  AzureAuth,
  SubscriptionItem,
  LocationItem
} from "./azure-auth/azureAuth";
import {
  CosmosDBDeploy,
  CosmosDBSelections,
  DatabaseObject
} from "./azure-cosmosDB/cosmosDbModule";
import {
  FunctionProvider,
  FunctionSelections
} from "./azure-functions/functionProvider";
import {
  CONSTANTS,
  AzureResourceType,
  DialogMessages,
  DialogResponses,
  ExtensionCommand,
  BackendFrameworkLinuxVersion
} from "../constants";
import {
  SubscriptionError,
  AuthorizationError,
  ValidationError
} from "../errors";
import { WizardServant, IPayloadResponse } from "../wizardServant";
import { AppNameValidationResult, NameValidator } from "./utils/nameValidator";
import { Logger } from "../utils/logger";
import {
  ResourceGroupDeploy,
  ResourceGroupSelection
} from "./azure-resource-group/resourceGroupModule";
import {
  AppServiceProvider,
  AppServiceSelections
} from "./azure-app-service/appServiceProvider";
import { NameGenerator } from "./utils/nameGenerator";
import { StringDictionary } from "azure-arm-website/lib/models";
import { ConnectionString } from "./utils/connectionString";

export class AzureServices extends WizardServant {
  clientCommandMap: Map<
    ExtensionCommand,
    (message: any) => Promise<IPayloadResponse>
  > = new Map([
    [ExtensionCommand.Login, AzureServices.performLoginForSubscriptions],
    [ExtensionCommand.GetUserStatus, AzureServices.sendUserStatusIfLoggedIn],
    [ExtensionCommand.Logout, AzureServices.performLogout],
    [ExtensionCommand.GetSubscriptionDataForCosmos, AzureServices.sendCosmosSubscriptionDataToClient],
    [ExtensionCommand.GetSubscriptionDataForAppService, AzureServices.sendAppServiceSubscriptionDataToClient],
    [ExtensionCommand.GetValidAppServiceName, AzureServices.GetValidAppServiceName],
    [ExtensionCommand.GetValidCosmosName, AzureServices.GetValidCosmosName],
    [
      ExtensionCommand.NameFunctions,
      AzureServices.sendFunctionNameValidationStatusToClient
    ],
    [
      ExtensionCommand.NameCosmos,
      AzureServices.sendCosmosNameValidationStatusToClient
    ],
    [
      ExtensionCommand.NameAppService,
      AzureServices.sendAppServiceNameValidationStatusToClient
    ]
  ]);

  private static AzureFunctionProvider = new FunctionProvider();
  private static AzureCosmosDBProvider = new CosmosDBDeploy();
  private static AzureAppServiceProvider = new AppServiceProvider();
  private static AzureResourceGroupProvider = new ResourceGroupDeploy();

  private static subscriptionItemList: SubscriptionItem[] = [];

  private static usersFunctionSubscriptionItemCache: SubscriptionItem;
  private static usersCosmosDBSubscriptionItemCache: SubscriptionItem;
  private static usersAppServiceSubscriptionItemCache: SubscriptionItem;

  public static async performLoginForSubscriptions(message: any): Promise<IPayloadResponse> {
    Logger.appendLog("EXTENSION", "info", "Attempt to log user in");
    const isLoggedIn = await AzureAuth.login();
    if (isLoggedIn) {
      Logger.appendLog("EXTENSION", "info", "User logged in");
      return AzureServices.sendUserStatusIfLoggedIn(message);
    }
    throw new AuthorizationError(CONSTANTS.ERRORS.LOGIN_TIMEOUT);
  }

  public static async sendUserStatusIfLoggedIn(message: any): Promise<IPayloadResponse> {
    if (AzureAuth.getEmail()) {
      AzureServices.subscriptionItemList = await AzureAuth.getSubscriptions();
      const subscriptionListToDisplay = AzureServices.subscriptionItemList.map(
        subscriptionItem => {
          return {
            label: subscriptionItem.label,
            value: subscriptionItem.label,
            isMicrosoftLearnSubscription: AzureServices.IsMicrosoftLearnSubscription(subscriptionItem)
          };
        }
      );
      return {
        payload: {
          scope:message.payload.scope,
          email: AzureAuth.getEmail(),
          subscriptions: subscriptionListToDisplay
        }
      };
    } else {
      return { payload: null };
    }
  }
  
  public static async performLogout(message: any): Promise<IPayloadResponse> {
    const success = await AzureAuth.logout();
    const payload: any = {scope : message.payload.scope, success};
    const payloadResponse: IPayloadResponse = { payload };
    return payloadResponse;
  }

  public static async sendAppServiceSubscriptionDataToClient(message: any): Promise<IPayloadResponse> {
    const data = await AzureServices.getSubscriptionData(message.subscription, AzureResourceType.AppService);
    return {
      payload: { 
        ...data, 
        scope: message.payload.scope
       }
    };
  }

  public static async sendCosmosSubscriptionDataToClient(message: any): Promise<IPayloadResponse> {
    const data = await AzureServices.getSubscriptionData(message.subscription, AzureResourceType.Cosmos);
    //TODO: Remove when CosmosDB modal refactor, and use GetValidCosmosName function to get valid name
    const validName = await NameGenerator.generateValidAzureTypeName(message.projectName, AzureResourceType.Cosmos);
    return {
      payload: {
        ...data,
        validName,
        scope: message.payload.scope
      }
    };
  }

  /**
   * @param subscriptionLabel subscription label
   * @returns a Json object of Formatted Resource and Location strings
   *
   * */
  private static async getSubscriptionData(subscriptionLabel: string, AzureType: AzureResourceType): Promise<any> {
    const subscriptionItem = AzureServices.subscriptionItemList.find(
      subscriptionItem => subscriptionItem.label === subscriptionLabel
    );
    if (subscriptionItem === undefined) {
      throw new SubscriptionError(CONSTANTS.ERRORS.SUBSCRIPTION_NOT_FOUND);
    }
    const resourceGroupItems = await AzureAuth.getAllResourceGroupItems(
      subscriptionItem
    ).then(resourceGroups => {
      const formatResourceGroupList = [];
      formatResourceGroupList.push(
        ...resourceGroups.map(resourceGroup => {
          return {
            label: resourceGroup.name,
            value: resourceGroup.name
          };
        })
      );
      return formatResourceGroupList;
    });

    let locationItems: LocationItem[] = [];
    switch (AzureType) {
      case AzureResourceType.Cosmos:
        locationItems = await AzureAuth.getLocationsForCosmos(subscriptionItem);
        break;
      case AzureResourceType.Functions:
      case AzureResourceType.AppService:
        locationItems = await AzureAuth.getLocationsForApp(subscriptionItem);
        break;
    }

    const locations = [];
    locations.push(
      ...locationItems.map(location => {
        return {
          label: location.locationDisplayName,
          value: location.locationDisplayName
        };
      })
    );

    return {
      resourceGroups: resourceGroupItems,
      locations
    };
  }

  public static async GetValidAppServiceName(message: any): Promise<IPayloadResponse> {
    const validName = await NameGenerator.generateValidAzureTypeName(message.projectName, AzureResourceType.AppService);
    return {
      payload: {
        validName,
        scope: message.payload.scope
      }
    };
  }

  public static async GetValidCosmosName(message: any): Promise<IPayloadResponse> {
    const validName = await NameGenerator.generateValidAzureTypeName(message.projectName, AzureResourceType.Cosmos);
    return {
      payload: {
        validName,
        scope: message.payload.scope
      }
    };
  }

  public static async validateNameForAzureType(
    projectName: string,
    userSubscriptionItem: SubscriptionItem,
    azureType: AzureResourceType
  ): Promise<boolean> {
    let validationResult;
    switch (azureType) {
      case AzureResourceType.AppService:
        validationResult = await AzureServices.AzureAppServiceProvider.checkWebAppName(
          projectName,
          userSubscriptionItem
        );
        break;
      case AzureResourceType.Cosmos:
        validationResult = await AzureServices.AzureCosmosDBProvider.validateCosmosDBAccountName(
          projectName,
          userSubscriptionItem
        );
        break;
      case AzureResourceType.Functions:
        validationResult = await AzureServices.AzureFunctionProvider.checkFunctionAppName(
          projectName,
          userSubscriptionItem
        );
        break;
    }
    return validationResult === undefined;
  }

  public static async sendAppServiceNameValidationStatusToClient(
    message: any
  ): Promise<IPayloadResponse> {
    await AzureServices.updateAppServiceSubscriptionItemCache(
      message.subscription
    );
    return await AzureServices.AzureAppServiceProvider.checkWebAppName(
      message.appName,
      AzureServices.usersAppServiceSubscriptionItemCache
    )
      .then((invalidReason: string | undefined) => {
        return {
          payload: {
            scope:message.payload.scope,
            isAvailable:
              !invalidReason ||
              invalidReason === undefined ||
              invalidReason === "",
            reason: invalidReason
          }
        };
      })
      .catch((error: Error) => {
        throw error; //to log in telemetry
      });
  }

  public static async sendCosmosNameValidationStatusToClient(
    message: any
  ): Promise<IPayloadResponse> {
    await AzureServices.updateCosmosDBSubscriptionItemCache(
      message.subscription
    );

    return await AzureServices.AzureCosmosDBProvider.validateCosmosDBAccountName(
      message.appName,
      AzureServices.usersCosmosDBSubscriptionItemCache
    )
      .then((invalidReason: string | undefined) => {
        return {
          payload: {
            scope:message.payload.scope,
            isAvailable:
              !invalidReason ||
              invalidReason === undefined ||
              invalidReason === "",
            reason: invalidReason
          }
        };
      })
      .catch((error: Error) => {
        throw error; //to log in telemetry
      });
  }

  public static async sendFunctionNameValidationStatusToClient(
    message: any
  ): Promise<IPayloadResponse> {
    await AzureServices.updateFunctionSubscriptionItemCache(
      message.subscription
    );
    return AzureServices.AzureFunctionProvider.checkFunctionAppName(
      message.appName,
      AzureServices.usersFunctionSubscriptionItemCache
    )
      .then((invalidReason: string | undefined) => {
        return {
          payload: {
            isAvailable:
              !invalidReason ||
              invalidReason === undefined ||
              invalidReason === "",
            reason: invalidReason
          }
        };
      })
      .catch((error: Error) => {
        throw error; //to log in telemetry
      });
  }

  /*
   * Caching is used for performance; when displaying live check on keystroke to wizard
   */

  private static async updateAppServiceSubscriptionItemCache(
    subscriptionLabel: string
  ): Promise<void> {
    if (
      AzureServices.usersAppServiceSubscriptionItemCache === undefined ||
      subscriptionLabel !==
        AzureServices.usersAppServiceSubscriptionItemCache.label
    ) {
      const subscriptionItem = AzureServices.subscriptionItemList.find(
        subscriptionItem => subscriptionItem.label === subscriptionLabel
      );
      if (subscriptionItem) {
        AzureServices.usersAppServiceSubscriptionItemCache = subscriptionItem;
      } else {
        throw new SubscriptionError(CONSTANTS.ERRORS.SUBSCRIPTION_NOT_FOUND);
      }
    }
  }

  private static async updateCosmosDBSubscriptionItemCache(
    subscriptionLabel: string
  ): Promise<void> {
    if (
      AzureServices.usersCosmosDBSubscriptionItemCache === undefined ||
      subscriptionLabel !==
        AzureServices.usersCosmosDBSubscriptionItemCache.label
    ) {
      const subscriptionItem = AzureServices.subscriptionItemList.find(
        subscriptionItem => subscriptionItem.label === subscriptionLabel
      );
      if (subscriptionItem) {
        AzureServices.usersCosmosDBSubscriptionItemCache = subscriptionItem;
      } else {
        throw new SubscriptionError(CONSTANTS.ERRORS.SUBSCRIPTION_NOT_FOUND);
      }
    }
  }

  private static async updateFunctionSubscriptionItemCache(
    subscriptionLabel: string
  ): Promise<void> {
    if (
      AzureServices.usersFunctionSubscriptionItemCache === undefined ||
      subscriptionLabel !==
        AzureServices.usersFunctionSubscriptionItemCache.label
    ) {
      const subscriptionItem = AzureServices.subscriptionItemList.find(
        subscriptionItem => subscriptionItem.label === subscriptionLabel
      );
      if (subscriptionItem) {
        AzureServices.usersFunctionSubscriptionItemCache = subscriptionItem;
      } else {
        throw new SubscriptionError(CONSTANTS.ERRORS.SUBSCRIPTION_NOT_FOUND);
      }
    }
  }

  public static async generateDistinctResourceGroupSelections(
    payload: any
  ): Promise<ResourceGroupSelection[]> {
    const projectName = payload.engine.projectName;
    const allSubscriptions: SubscriptionItem[] = [];

    if (payload.selectedFunctions) {
      await AzureServices.updateFunctionSubscriptionItemCache(
        payload.functions.subscription
      );
      allSubscriptions.push(AzureServices.usersFunctionSubscriptionItemCache);
    }
    if (payload.selectedCosmos) {
      await AzureServices.updateCosmosDBSubscriptionItemCache(
        payload.cosmos.subscription
      );
      allSubscriptions.push(AzureServices.usersCosmosDBSubscriptionItemCache);
    }
    if (payload.selectedAppService) {
      await AzureServices.updateAppServiceSubscriptionItemCache(
        payload.appService.subscription
      );
      allSubscriptions.push(AzureServices.usersAppServiceSubscriptionItemCache);
    }
    const allDistinctSubscriptions: SubscriptionItem[] = [
      ...new Set(allSubscriptions)
    ];
    const generatedName: string = await AzureServices.AzureResourceGroupProvider.generateValidResourceGroupName(
      projectName,
      allDistinctSubscriptions
    );

    return await Promise.all(
      allDistinctSubscriptions.map(
        async subscription =>
          await AzureServices.generateResourceGroupSelection(
            generatedName,
            subscription
          )
      )
    );
  }

  private static async generateResourceGroupSelection(
    generatedName: string,
    subscriptionItem: SubscriptionItem
  ): Promise<ResourceGroupSelection> {
    let resourceGroupName = generatedName;
    if (AzureServices.IsMicrosoftLearnSubscription(subscriptionItem)) {
      const resourceGroups = await AzureServices.AzureResourceGroupProvider.GetResourceGroups(subscriptionItem);
      resourceGroupName = resourceGroups[0].name as string;
    }
    return {
      subscriptionItem: subscriptionItem,
      resourceGroupName: resourceGroupName,
      location: CONSTANTS.AZURE_LOCATION.CENTRAL_US
    };
  }

  public static async deployResourceGroup(
    selections: ResourceGroupSelection
  ): Promise<any> {
    if (!AzureServices.IsMicrosoftLearnSubscription(selections.subscriptionItem)) {
      return await AzureServices.AzureResourceGroupProvider.createResourceGroup(
        selections
      );
    }
  }

  public static async deployWebApp(payload: any): Promise<string> {
    await AzureServices.updateAppServiceSubscriptionItemCache(
      payload.appService.subscription
    );
    const aspName = await AzureServices.AzureAppServiceProvider.generateValidASPName(
      payload.engine.projectName
    );
    const appServicePlan = AzureServices.IsMicrosoftLearnSubscription(
      AzureServices.usersAppServiceSubscriptionItemCache
    )
      ? CONSTANTS.SKU_DESCRIPTION.FREE
      : CONSTANTS.SKU_DESCRIPTION.BASIC;

    const userAppServiceSelection: AppServiceSelections = {
      siteName: payload.appService.siteName,
      subscriptionItem: AzureServices.usersAppServiceSubscriptionItemCache,
      resourceGroupItem: await AzureAuth.getResourceGroupItem(
        payload.appService.resourceGroup,
        AzureServices.usersAppServiceSubscriptionItemCache
      ),
      appServicePlanName: aspName,
      tier: appServicePlan.tier,
      sku: appServicePlan.name,
      linuxFxVersion:
        BackendFrameworkLinuxVersion[payload.engine.backendFramework],
      location: CONSTANTS.AZURE_LOCATION.CENTRAL_US
    };

    await AzureServices.AzureAppServiceProvider.checkWebAppName(
      userAppServiceSelection.siteName,
      userAppServiceSelection.subscriptionItem
    )
      .then(invalidReason => {
        if (invalidReason !== undefined && invalidReason === "") {
          throw new ValidationError(invalidReason);
        }
      })
      .catch((error: Error) => {
        throw error; //to log in telemetry
      });

    const result = await AzureServices.AzureAppServiceProvider.createWebApp(
      userAppServiceSelection,
      payload.engine.path
    );
    if (!result) {
      throw new Error(CONSTANTS.ERRORS.APP_SERVICE_UNDEFINED_ID);
    }
    return AzureServices.convertId(result);
  }

  private static convertId(rawId: string): string {
    // workaround to convert deployment id to app service id
    const MS_RESOURCE_DEPLOYMENT = "Microsoft.Resources/deployments";
    const MS_WEB_SITE = "Microsoft.Web/sites";
    return rawId
      .replace(MS_RESOURCE_DEPLOYMENT, MS_WEB_SITE)
      .replace("-" + AzureResourceType.AppService, "");
  }

  public static async deployFunctionApp(
    selections: any,
    appPath: string
  ): Promise<void> {
    await AzureServices.updateFunctionSubscriptionItemCache(
      selections.subscription
    );

    const userFunctionsSelections: FunctionSelections = {
      functionAppName: selections.appName,
      subscriptionItem: AzureServices.usersFunctionSubscriptionItemCache,
      resourceGroupItem: await AzureAuth.getResourceGroupItem(
        selections.resourceGroup,
        AzureServices.usersFunctionSubscriptionItemCache
      ),
      location: selections.location,
      runtime: selections.runtimeStack,
      functionNames: selections.functionNames
    };

    const functionNamesValidation: AppNameValidationResult = NameValidator.validateFunctionNames(
      userFunctionsSelections.functionNames
    );
    if (!functionNamesValidation.isValid) {
      throw new ValidationError(functionNamesValidation.message);
    }

    await AzureServices.AzureFunctionProvider.checkFunctionAppName(
      userFunctionsSelections.functionAppName,
      userFunctionsSelections.subscriptionItem
    )
      .then(invalidReason => {
        if (invalidReason !== undefined && invalidReason === "") {
          throw new ValidationError(invalidReason);
        }
      })
      .catch((error: Error) => {
        throw error; //to log in telemetry
      });

    return await AzureServices.AzureFunctionProvider.createFunctionApp(
      userFunctionsSelections,
      appPath
    );
  }

  public static async deployCosmosResource(
    selections: any,
    genPath: string
  ): Promise<DatabaseObject> {
    await AzureServices.updateCosmosDBSubscriptionItemCache(
      selections.subscription
    );

    const userCosmosDBSelection: CosmosDBSelections = {
      cosmosAPI: selections.api,
      cosmosDBResourceName: selections.accountName,
      location: CONSTANTS.AZURE_LOCATION.CENTRAL_US,
      resourceGroupItem: await AzureAuth.getResourceGroupItem(
        selections.resourceGroup,
        AzureServices.usersCosmosDBSubscriptionItemCache
      ),
      subscriptionItem: AzureServices.usersCosmosDBSubscriptionItemCache
    };

    await AzureServices.AzureCosmosDBProvider.validateCosmosDBAccountName(
      userCosmosDBSelection.cosmosDBResourceName,
      userCosmosDBSelection.subscriptionItem
    )
      .then(invalidReason => {
        if (invalidReason !== undefined && invalidReason === "") {
          throw new ValidationError(invalidReason);
        }
      })
      .catch((error: Error) => {
        throw error; //to log in telemetry
      });

    return await AzureServices.AzureCosmosDBProvider.createCosmosDB(
      userCosmosDBSelection,
      genPath
    );
  }
  public static async promptUserForCosmosReplacement(
    pathToEnv: string,
    dbObject: DatabaseObject
  ): Promise<any> {
    return await vscode.window
      .showInformationMessage(
        DialogMessages.cosmosDBConnectStringReplacePrompt,
        ...[DialogResponses.yes, DialogResponses.no]
      )
      .then((selection: vscode.MessageItem | undefined) => {
        const start = Date.now();
        if (selection === DialogResponses.yes) {
          CosmosDBDeploy.updateConnectionStringInEnvFile(
            pathToEnv,
            dbObject.connectionString
          );
          vscode.window.showInformationMessage(
            CONSTANTS.INFO.FILE_REPLACED_MESSAGE + pathToEnv
          );
        }
        return {
          userReplacedEnv: selection === DialogResponses.yes,
          startTime: start
        };
      });
  }
  public static async updateAppSettings(
    resourceGroupName: string,
    webAppName: string,
    connectionString: string
  ): Promise<void> {
    const parsed: string = ConnectionString.parseConnectionString(
      connectionString
    );
    const settings: StringDictionary = {
      properties: AzureServices.convertToSettings(parsed)
    };

    AzureServices.AzureAppServiceProvider.updateAppSettings(
      resourceGroupName,
      webAppName,
      settings
    );
  }

  private static convertToSettings(
    parsedConnectionString: string
  ): { [s: string]: string } {
    // format of parsedConnectionString: "<key1>=<value1>\n<key2>=<value2>\n<key3>=<value3>\n"
    const fields = parsedConnectionString.split("\n");
    const result: { [s: string]: string } = {};
    for (let i = 0; i < fields.length - 1; i++) {
      const key = fields[i].substr(0, fields[i].indexOf("="));
      const value = fields[i].substr(fields[i].indexOf("=") + 1);
      result[key] = value;
    }
    return result;
  }

  private static IsMicrosoftLearnSubscription(
    subscriptionItem: SubscriptionItem
  ): boolean {
    return MICROSOFT_LEARN_TENANTS.includes(
      subscriptionItem.session.tenantId
    );
  }
}
