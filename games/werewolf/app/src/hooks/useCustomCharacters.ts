"use client";

import { useCallback, useEffect, useState } from "react";
import type { CustomCharacter, CustomCharacterInput } from "@/types/custom-character";
import { DEFAULT_CUSTOM_CHARACTER_AGE, DEFAULT_CUSTOM_CHARACTER_GENDER, MAX_CUSTOM_CHARACTERS } from "@/types/custom-character";
import { fillCustomCharacterOptionalFields } from "@/lib/custom-character-defaults";
import { generateUUID } from "@/lib/utils";

const STORAGE_KEY = "wolfcha.custom_characters.v1";

function readLocalCharacters(): CustomCharacter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item === "object" && !item.is_deleted)
      : [];
  } catch {
    return [];
  }
}

function writeLocalCharacters(characters: CustomCharacter[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(characters));
  } catch {
    // Ignore quota/storage errors; in-memory state remains usable.
  }
}

export function useCustomCharacters() {
  const [characters, setCharacters] = useState<CustomCharacter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCharacters = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCharacters(readLocalCharacters());
    setLoading(false);
  }, []);

  const createCharacter = useCallback(async (input: CustomCharacterInput): Promise<CustomCharacter | null> => {
    if (characters.length >= MAX_CUSTOM_CHARACTERS) {
      setError(`Maximum ${MAX_CUSTOM_CHARACTERS} custom characters allowed`);
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const normalizedInput = fillCustomCharacterOptionalFields(input);
      const avatarSeed = input.avatar_seed || `${input.display_name}-${Date.now()}`;
      const now = new Date().toISOString();
      const newChar: CustomCharacter = {
        id: generateUUID(),
        user_id: "local",
        display_name: normalizedInput.display_name.trim(),
        gender: normalizedInput.gender,
        age: normalizedInput.age,
        mbti: normalizedInput.mbti.toUpperCase(),
        basic_info: normalizedInput.basic_info?.trim() || undefined,
        style_label: normalizedInput.style_label?.trim() || undefined,
        avatar_seed: avatarSeed,
        is_deleted: false,
        created_at: now,
        updated_at: now,
      };
      setCharacters(prev => {
        const next = [newChar, ...prev];
        writeLocalCharacters(next);
        return next;
      });
      return newChar;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create character");
      return null;
    } finally {
      setLoading(false);
    }
  }, [characters.length]);

  const updateCharacter = useCallback(async (
    id: string,
    input: Partial<CustomCharacterInput>
  ): Promise<CustomCharacter | null> => {
    setLoading(true);
    setError(null);

    try {
      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

      const shouldNormalizeOptionalFields =
        input.mbti !== undefined || input.basic_info !== undefined || input.style_label !== undefined;
      const normalizedInput = shouldNormalizeOptionalFields
        ? fillCustomCharacterOptionalFields({
            display_name: input.display_name ?? "",
            gender: (input.gender as CustomCharacterInput["gender"]) ?? DEFAULT_CUSTOM_CHARACTER_GENDER,
            age: input.age ?? DEFAULT_CUSTOM_CHARACTER_AGE,
            mbti: input.mbti ?? "",
            basic_info: input.basic_info ?? "",
            style_label: input.style_label ?? "",
            avatar_seed: input.avatar_seed,
          })
        : null;
      
      if (input.display_name !== undefined) updateData.display_name = input.display_name.trim();
      if (input.gender !== undefined) updateData.gender = input.gender;
      if (input.age !== undefined) updateData.age = input.age;
      if (input.mbti !== undefined) updateData.mbti = (normalizedInput?.mbti ?? input.mbti).toUpperCase();
      if (input.basic_info !== undefined) updateData.basic_info = normalizedInput?.basic_info?.trim() || null;
      if (input.style_label !== undefined) updateData.style_label = normalizedInput?.style_label?.trim() || null;
      if (input.avatar_seed !== undefined) updateData.avatar_seed = input.avatar_seed;

      let updated: CustomCharacter | null = null;
      setCharacters(prev => {
        const next = prev.map(c => {
          if (c.id !== id) return c;
          updated = { ...c, ...updateData, updated_at: new Date().toISOString() } as CustomCharacter;
          return updated;
        });
        writeLocalCharacters(next);
        return next;
      });
      return updated;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update character");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteCharacter = useCallback(async (id: string): Promise<boolean> => {
    setLoading(true);
    setError(null);

    try {
      setCharacters(prev => {
        const next = prev.filter(c => c.id !== id);
        writeLocalCharacters(next);
        return next;
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete character");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCharacters();
  }, [fetchCharacters]);

  return {
    characters,
    loading,
    error,
    fetchCharacters,
    createCharacter,
    updateCharacter,
    deleteCharacter,
    canAddMore: characters.length < MAX_CUSTOM_CHARACTERS,
    remainingSlots: MAX_CUSTOM_CHARACTERS - characters.length,
  };
}
