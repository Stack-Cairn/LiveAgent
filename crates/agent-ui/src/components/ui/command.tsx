import { Command as CommandPrimitive } from "cmdk";

// Keep command behavior reusable without imposing a new visual skin.
export const Command = CommandPrimitive;
export const CommandInput = CommandPrimitive.Input;
export const CommandList = CommandPrimitive.List;
export const CommandItem = CommandPrimitive.Item;
