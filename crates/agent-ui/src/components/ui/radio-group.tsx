import { Radio } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

// Unstyled composition keeps existing segmented and native-looking radio skins.
export const RadioGroup = RadioGroupPrimitive;
export const RadioGroupItem = Radio.Root;
