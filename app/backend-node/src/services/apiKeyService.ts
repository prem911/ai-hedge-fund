import * as apiKeyRepo from "../repositories/apiKeyRepository.js";

export class ApiKeyService {
  async getApiKeysDict(): Promise<Record<string, string>> {
    const keys = await apiKeyRepo.getAllApiKeys(false);
    const result: Record<string, string> = {};
    for (const key of keys) {
      result[key["provider"] as string] = key["key_value"] as string;
    }
    return result;
  }

  async getApiKey(provider: string): Promise<string | null> {
    const key = await apiKeyRepo.getApiKeyByProvider(provider);
    return key ? (key["key_value"] as string) : null;
  }
}

export const apiKeyService = new ApiKeyService();
