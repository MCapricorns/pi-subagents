import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** Preserve enum inference when Pi's JSON Schema helpers are nested in TypeBox. */
export function stringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) {
	return Type.Unsafe<T[number]>(StringEnum(values, options));
}
