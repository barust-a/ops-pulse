/** The current time, injected so every rule depending on "now" is testable. */
export type Clock = () => Date;
