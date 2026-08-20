import React, { useEffect, useRef } from 'react';
import styled from 'styled-components';
import { app as splunkApp } from '@splunk/splunk-utils/config';
import { logservTheme } from '../styles/logservTheme';
import { APP_VERSION, APP_BUILD, APP_BUILD_DATE } from '../buildFlags';

/**
 * About dialog — opened from the "About" item in the navigation bar.
 *
 * Shows the app icon, the customer-facing solution name, and the version
 * + build number of the running app. Version and build are compile-time
 * constants read from `default/app.conf` (see `buildFlags.ts`), so they
 * always describe the installed bundle and cannot drift.
 *
 * Behavior mirrors the app's other dialogs (LayoutNameModal /
 * ManageLayoutsModal): backdrop click, Escape, and the Close button all
 * dismiss; focus moves to Close on open.
 *
 * Build 302 / session 092.
 */

interface AboutModalProps {
    open: boolean;
    onClose: () => void;
}

/** `/<locale>/static/app/<app>/appIcon_2x.png`.
 *
 *  Splunk Web serves an app's `appserver/static/` tree at
 *  `/<locale>/static/app/<app>/` — note this is NOT the top-level
 *  `<app>/static/` directory that the Splunk launcher reads its tile icon
 *  from; that one is not web-served. The build ships a copy of the icon
 *  under `appserver/static/` for this dialog. Same URL derivation as the
 *  bundled web fonts in `styles/fonts.ts`. */
const iconUrl = (): string => {
    let locale = 'en-US';
    try {
        const m = window.location.pathname.match(/^\/([^/]+)\/(?:app|manager)\//);
        if (m) locale = m[1];
    } catch (_e) {
        /* ignore — fall back to en-US */
    }
    const appId =
        typeof splunkApp === 'string' && splunkApp ? splunkApp : 'splunk_app_sap_logserv';
    return `/${locale}/static/app/${appId}/appIcon_2x.png`;
};

const Backdrop = styled.div`
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 9000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
`;

const Dialog = styled.div`
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.cyanAccent};
    border-radius: ${logservTheme.radius.small};
    width: 100%;
    max-width: 420px;
    color: ${logservTheme.colors.textActive};
    font-family: inherit;
    display: flex;
    flex-direction: column;
`;

/* Icon left, product name right — the icon is decorative here (the
   adjacent heading carries the name), so it is marked aria-hidden and
   given an empty alt rather than duplicating the title to screen
   readers. */
const Header = styled.div`
    padding: 20px 22px 16px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const Icon = styled.img`
    width: 56px;
    height: 56px;
    flex: 0 0 auto;
    border-radius: ${logservTheme.radius.small};
`;

const Title = styled.h3`
    margin: 0;
    font-size: ${logservTheme.fontSize.large};
    font-weight: ${logservTheme.fontWeight.semibold};
    line-height: 1.3;
`;

const Body = styled.div`
    padding: 18px 22px;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 18px;
    align-items: baseline;
`;

const Label = styled.div`
    font-size: ${logservTheme.fontSize.small};
    color: ${logservTheme.colors.textMuted};
    text-transform: uppercase;
    letter-spacing: 0.5px;
`;

const Value = styled.div`
    font-size: ${logservTheme.fontSize.body};
    font-family: ${logservTheme.font.mono};
    color: ${logservTheme.colors.textActive};
`;

const Footer = styled.div`
    padding: 12px 18px;
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    display: flex;
    justify-content: flex-end;
`;

const Button = styled.button`
    background: ${logservTheme.colors.cyanAccent};
    /* Filled control — light text in BOTH modes; textActive resolves
       near-black in light mode and would be unreadable on the fill. */
    color: ${logservTheme.colors.inverseText};
    border: 1px solid ${logservTheme.colors.cyanAccent};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 14px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    cursor: pointer;

    &:hover {
        background: ${logservTheme.colors.cyanLight};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: 2px;
    }
`;

const AboutModal: React.FC<AboutModalProps> = ({ open, onClose }) => {
    const closeRef = useRef<HTMLButtonElement>(null);

    // Focus the Close button on open so Escape/Enter both work immediately
    // and keyboard users land inside the dialog.
    useEffect(() => {
        if (!open) return;
        const t = window.setTimeout(() => closeRef.current?.focus(), 0);
        // eslint-disable-next-line consistent-return
        return () => window.clearTimeout(t);
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    return (
        <Backdrop
            onClick={onClose}
            role="presentation"
            data-test="about-modal-backdrop"
        >
            {/* Stop propagation so clicks inside the dialog don't dismiss it. */}
            <Dialog
                role="dialog"
                aria-modal="true"
                aria-label="About Splunk for SAP LogServ"
                onClick={(e) => e.stopPropagation()}
            >
                <Header>
                    <Icon src={iconUrl()} alt="" aria-hidden />
                    <Title>Splunk for SAP LogServ</Title>
                </Header>

                <Body>
                    <Label>Version</Label>
                    <Value data-test="about-version">{APP_VERSION || '—'}</Value>
                    <Label>Build</Label>
                    <Value data-test="about-build">{APP_BUILD || '—'}</Value>
                    <Label>Build date</Label>
                    {/* UTC — stated in the tooltip so a reader in another
                        timezone isn't left guessing which day is meant. */}
                    <Value data-test="about-build-date" title={APP_BUILD_DATE ? `${APP_BUILD_DATE} (UTC)` : undefined}>
                        {APP_BUILD_DATE || '—'}
                    </Value>
                </Body>

                <Footer>
                    <Button type="button" ref={closeRef} onClick={onClose}>
                        Close
                    </Button>
                </Footer>
            </Dialog>
        </Backdrop>
    );
};

export default AboutModal;
