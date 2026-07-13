/**
 * GCP Pub/Sub input - Input Form Hook
 *
 * Handles the encrypted-field UX problem for the `service_account_key` field (same
 * pattern as the Demo Gen TA's hec_token hook):
 *
 *   - `service_account_key` is `required: true` + `encrypted: true`. UCC renders
 *     encrypted fields BLANK in Edit mode (the value is preserved
 *     server-side). With `required: true`, the validator fires on Save unless
 *     the user retypes the entire service-account key -- so editing any OTHER field (e.g.
 *     bumping the interval) would force the user to paste the key again.
 *
 * Fix:
 *   1. onEditLoad() pre-fills `service_account_key` with "******" so the required-field
 *      validator passes when the user clicks Update without touching it.
 *   2. onSave(dataDict) strips `service_account_key` from the outbound PATCH IF it still
 *      equals "******" (user didn't change it). UCC's REST handler, on a
 *      PATCH that omits the encrypted field, preserves the stored value.
 *
 * The placeholder MUST be exactly '******' (6 asterisks) so splunktaucclib's
 * server-side RestCredentials.is_placeholder() recognizes it. (Implies the
 * service_account_key field must NOT carry a minLength >= 7 validator -- it doesn't.)
 *
 * Constructor-arg detection mirrors the Demo Gen hook: the UCC hook signature
 * has drifted across versions (4/5/6-arg), so we detect `util` (has setState)
 * and `mode` (the string) by shape rather than position.
 */

const PLACEHOLDER = '******';
const TOKEN_FIELD = 'service_account_key';

class AzureQueueInputHook {
    constructor() {
        const args = Array.prototype.slice.call(arguments);
        this.globalConfig = args[0];
        this.serviceName = args[1];
        this.state = null;
        this.mode = null;
        this.util = null;
        for (let i = 2; i < args.length; i += 1) {
            const a = args[i];
            if (a && typeof a === 'object' && typeof a.setState === 'function') {
                this.util = a;
            } else if (typeof a === 'string' &&
                       (a === 'edit' || a === 'create' || a === 'clone')) {
                this.mode = a;
            } else if (a && typeof a === 'object' && a.data) {
                this.state = a;
            }
        }
    }

    onCreate() {}
    onRender() {}
    onChange(/* field, value, dataDict */) {}
    onSaveSuccess() {}
    onSaveFail() {}

    onEditLoad() {
        if (!this.util || typeof this.util.setState !== 'function') {
            return;
        }
        this.util.setState((prevState) => {
            if (!prevState || !prevState.data || !prevState.data[TOKEN_FIELD]) {
                return prevState;
            }
            return {
                ...prevState,
                data: {
                    ...prevState.data,
                    [TOKEN_FIELD]: {
                        ...prevState.data[TOKEN_FIELD],
                        value: PLACEHOLDER,
                        error: false,
                    },
                },
            };
        });
    }

    onSave(dataDict) {
        if (dataDict && dataDict[TOKEN_FIELD] === PLACEHOLDER) {
            delete dataDict[TOKEN_FIELD];
        }
        return true;
    }
}

export default AzureQueueInputHook;
