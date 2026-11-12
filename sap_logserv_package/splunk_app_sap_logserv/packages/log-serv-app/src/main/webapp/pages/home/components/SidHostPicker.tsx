import React, { useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { HostService, useSidHostFilter } from '../state/SidHostFilterProvider';
import { SidHost, describeHost, findSid } from '../utils/sidHostMap';
import { logservTheme } from '../styles/logservTheme';

/**
 * SidHostPicker — the title-row dropdowns for the global SID and Host filters
 * (build 395). Rendered by DashboardLayout beside CloudProviderPicker, and styled
 * to read as one strip with it: an accent border means a filter is in effect.
 *
 *  - SidPicker: one SAP system. Picking it takes all its hosts, its database's
 *    hosts and its standby and disaster recovery hosts.
 *  - GlobalHostPicker: narrows to hosts of that system, each shown with its role.
 *    With no SID selected it lists every SAP host.
 *  - ServiceHostPicker: the Host filter of a dashboard whose hosts belong to no SID.
 */

const RAW_NOTE =
    'While a filter is on, panels whose stored summaries have no host read raw events, so they can take longer. The trend lines under some KPI cards and the beaconing panels cannot be filtered: a trend goes blank, and the beaconing panels say so.';

const Wrapper = styled.div`
    position: relative;
    display: inline-flex;
    align-items: center;
`;

const PickerButton = styled.button<{ $active: boolean; $filtered: boolean }>`
    background: ${(p) => (p.$active ? logservTheme.colors.hoverBackground : 'transparent')};
    color: ${(p) =>
        p.$active || p.$filtered ? logservTheme.colors.cyanLight : logservTheme.colors.textActive};
    border: 1px solid
        ${(p) =>
            p.$active || p.$filtered
                ? logservTheme.colors.cyanAccent
                : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    box-sizing: border-box;
    height: 32px;
    padding: 0 12px;
    align-self: center;
    cursor: pointer;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    max-width: 240px;
    transition: background-color 80ms ease-out, border-color 80ms ease-out, color 80ms ease-out;

    &:hover:not(:disabled) {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.cyanAccent};
    }

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const ButtonText = styled.span`
    overflow: hidden;
    text-overflow: ellipsis;
`;

const Caret = styled.span`
    margin-left: 2px;
`;

const Menu = styled.div`
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    width: 380px;
    background: ${logservTheme.colors.panelBackground};
    border: 1px solid ${logservTheme.colors.panelBorder};
    border-radius: ${logservTheme.radius.small};
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
    z-index: 1000;
    padding: 4px 0;
`;

const MenuList = styled.div`
    max-height: 340px;
    overflow-y: auto;
`;

const FilterInput = styled.input`
    display: block;
    box-sizing: border-box;
    width: calc(100% - 16px);
    margin: 4px 8px 6px;
    height: 28px;
    padding: 0 8px;
    background: transparent;
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};

    &:focus {
        outline: 2px solid ${logservTheme.colors.cyanAccent};
        outline-offset: -2px;
    }
`;

const MenuItem = styled.button<{ $selected: boolean }>`
    background: ${(p) => (p.$selected ? logservTheme.colors.hoverBackground : 'transparent')};
    border: none;
    color: ${(p) => (p.$selected ? logservTheme.colors.cyanLight : logservTheme.colors.textActive)};
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    padding: 7px 12px;
    width: 100%;
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 8px;

    &:hover:not(:disabled) {
        background: ${logservTheme.colors.hoverBackground};
        color: ${logservTheme.colors.cyanLight};
    }
`;

const Tick = styled.span`
    flex: 0 0 12px;
    color: ${logservTheme.colors.cyanLight};
    font-size: 12px;
    line-height: 1;
`;

const Name = styled.span`
    flex: 0 0 auto;
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const Detail = styled.span`
    flex: 1 1 auto;
    min-width: 0;
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
`;

const Note = styled.div`
    padding: 8px 12px 6px;
    margin-top: 4px;
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
`;

const Empty = styled.div`
    padding: 8px 12px;
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
`;

/** Close on outside click / escape — matches CloudProviderPicker. */
const useDropdown = () => {
    const [open, setOpen] = useState<boolean>(false);
    const [filter, setFilter] = useState<string>('');
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return undefined;
        const onDocClick = (e: MouseEvent): void => {
            const node = e.target as Node | null;
            if (wrapperRef.current && node && !wrapperRef.current.contains(node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    useEffect(() => {
        if (!open) setFilter('');
    }, [open]);

    return { open, setOpen, filter, setFilter, wrapperRef };
};

const matches = (filter: string, ...parts: string[]): boolean => {
    const f = filter.trim().toLowerCase();
    return !f || parts.some((p) => p.toLowerCase().indexOf(f) !== -1);
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const SidPicker: React.FC = () => {
    const { map, mapLoading, mapFailed, refreshMap, selection, setSid } = useSidHostFilter();
    const { open, setOpen, filter, setFilter, wrapperRef } = useDropdown();
    const { sid } = selection;

    const shown = useMemo(
        () => map.sids.filter((e) => matches(filter, e.sid, e.databases.join(' '))),
        [map.sids, filter],
    );

    const choose = (next: string | null) => () => {
        setSid(next);
        setOpen(false);
    };

    return (
        <Wrapper ref={wrapperRef}>
            <PickerButton
                type="button"
                onClick={() => {
                    // The list may have been built since the page loaded.
                    if (!open && map.sids.length === 0) refreshMap();
                    setOpen((v) => !v);
                }}
                $active={open}
                $filtered={!!sid}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`SID filter: ${sid ?? 'All'}`}
                title={
                    sid
                        ? `Filtering to SAP system ${sid}, its database and its standby hosts — click to change`
                        : 'SID: showing all SAP systems — click to filter'
                }
            >
                <ButtonText>{`SID: ${sid ?? 'All'}`}</ButtonText>
                <Caret aria-hidden>▾</Caret>
            </PickerButton>
            {open && (
                <Menu role="menu">
                    {map.sids.length > 8 && (
                        <FilterInput
                            autoFocus
                            placeholder="Filter systems"
                            aria-label="Filter systems"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                    )}
                    <MenuList>
                        <MenuItem type="button" role="menuitem" $selected={!sid} onClick={choose(null)}>
                            <Tick aria-hidden>{!sid ? '✓' : ''}</Tick>
                            <Name>All systems</Name>
                        </MenuItem>
                        {shown.map((e) => {
                            const selected = e.sid === sid;
                            const detail = e.databases.length > 0
                                ? `${plural(e.hosts.length, 'host')}, database ${e.databases.join(', ')}`
                                : plural(e.hosts.length, 'host');
                            return (
                                <MenuItem
                                    key={e.sid}
                                    type="button"
                                    role="menuitem"
                                    $selected={selected}
                                    onClick={choose(e.sid)}
                                >
                                    <Tick aria-hidden>{selected ? '✓' : ''}</Tick>
                                    <Name>{e.sid}</Name>
                                    <Detail>{detail}</Detail>
                                </MenuItem>
                            );
                        })}
                    </MenuList>
                    {map.sids.length === 0 && (
                        <Empty>
                            {mapLoading && 'Loading systems…'}
                            {!mapLoading && mapFailed && 'The list of SAP systems could not be read.'}
                            {!mapLoading && !mapFailed
                                && 'No SAP systems are listed yet. The list is built every hour from what each host logs.'}
                        </Empty>
                    )}
                    <Note>{RAW_NOTE}</Note>
                </Menu>
            )}
        </Wrapper>
    );
};

interface HostMenuProps {
    label: string;
    options: SidHost[];
    picked: string[];
    onChange: (hosts: string[]) => void;
    allLabel: string;
    emptyText: string;
    title: string;
    onOpen?: () => void;
}

const HostMenu: React.FC<HostMenuProps> = ({ label, options, picked, onChange, allLabel, emptyText, title, onOpen }) => {
    const { open, setOpen, filter, setFilter, wrapperRef } = useDropdown();

    const shown = useMemo(
        () => options.filter((h) => matches(filter, h.host, describeHost(h))),
        [options, filter],
    );

    const toggle = (host: string) => () => {
        onChange(picked.indexOf(host) === -1 ? picked.concat(host) : picked.filter((h) => h !== host));
    };

    return (
        <Wrapper ref={wrapperRef}>
            <PickerButton
                type="button"
                onClick={() => {
                    if (!open && onOpen) onOpen();
                    setOpen((v) => !v);
                }}
                $active={open}
                $filtered={picked.length > 0}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Host filter: ${label}`}
                title={title}
            >
                <ButtonText>{`Host: ${label}`}</ButtonText>
                <Caret aria-hidden>▾</Caret>
            </PickerButton>
            {open && (
                <Menu role="menu">
                    {options.length > 8 && (
                        <FilterInput
                            autoFocus
                            placeholder="Filter hosts"
                            aria-label="Filter hosts"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                    )}
                    <MenuList>
                        <MenuItem
                            type="button"
                            role="menuitem"
                            $selected={picked.length === 0}
                            onClick={() => {
                                onChange([]);
                                setOpen(false);
                            }}
                        >
                            <Tick aria-hidden>{picked.length === 0 ? '✓' : ''}</Tick>
                            <Name>{allLabel}</Name>
                        </MenuItem>
                        {shown.map((h) => {
                            const selected = picked.indexOf(h.host) !== -1;
                            const detail = describeHost(h);
                            return (
                                <MenuItem
                                    key={h.host}
                                    type="button"
                                    role="menuitemcheckbox"
                                    aria-checked={selected}
                                    $selected={selected}
                                    onClick={toggle(h.host)}
                                >
                                    <Tick aria-hidden>{selected ? '✓' : ''}</Tick>
                                    <Name>{h.host}</Name>
                                    {detail && <Detail title={detail}>{detail}</Detail>}
                                </MenuItem>
                            );
                        })}
                    </MenuList>
                    {options.length === 0 && <Empty>{emptyText}</Empty>}
                    <Note>{RAW_NOTE}</Note>
                </Menu>
            )}
        </Wrapper>
    );
};

const hostButtonLabel = (picked: string[]): string => {
    if (picked.length === 0) return 'All';
    if (picked.length === 1) return picked[0];
    return plural(picked.length, 'host');
};

export const GlobalHostPicker: React.FC = () => {
    const { map, mapLoading, allHostNames, allHostsLoading, requestAllHosts, selection, setHosts } = useSidHostFilter();
    const entry = findSid(map, selection.sid);
    // With a SID selected: its hosts and no others, from what the selection stored
    // if the list cannot be read right now. With none: SAP hosts with their roles, and
    // every other host with events (a Windows or plain Linux host has no SID evidence).
    // Either way, a stored pick stays visible and clearable.
    const options = useMemo<SidHost[]>(() => {
        let base = map.hosts;
        if (selection.sid) base = entry ? entry.hosts : selection.scopeHosts.map((host) => ({ host, roles: [] }));
        const have = new Set(base.map((h) => h.host));
        const extra: SidHost[] = [];
        (selection.sid ? [] : allHostNames).concat(selection.hosts).forEach((host) => {
            if (!have.has(host)) {
                have.add(host);
                extra.push({ host, roles: [] });
            }
        });
        const all = base.concat(extra);
        return selection.sid ? all : all.sort((a, b) => (a.host < b.host ? -1 : 1));
    }, [entry, map.hosts, allHostNames, selection.sid, selection.scopeHosts, selection.hosts]);

    return (
        <HostMenu
            label={hostButtonLabel(selection.hosts)}
            options={options}
            picked={selection.hosts}
            onChange={setHosts}
            allLabel={selection.sid ? `All hosts of ${selection.sid}` : 'All hosts'}
            onOpen={selection.sid ? undefined : requestAllHosts}
            emptyText={mapLoading || allHostsLoading ? 'Loading hosts…' : 'No hosts in this time range.'}
            title={
                selection.hosts.length > 0
                    ? `Filtering to ${plural(selection.hosts.length, 'host')} — click to change`
                    : 'Host: showing all hosts — click to filter'
            }
        />
    );
};

export const ServiceHostPicker: React.FC<{ service: HostService }> = ({ service }) => {
    const { serviceHosts, setServiceHosts, serviceHostOptions, serviceHostsLoading, setActiveService } =
        useSidHostFilter();
    const picked = serviceHosts[service] ?? [];

    useEffect(() => {
        setActiveService(service);
        return () => setActiveService(null);
    }, [service, setActiveService]);

    const options = useMemo<SidHost[]>(() => {
        const names = serviceHostOptions.concat(picked.filter((h) => serviceHostOptions.indexOf(h) === -1));
        return names.map((host) => ({ host, roles: [] }));
        // `picked` is rebuilt from the stored list; its contents are what matter.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serviceHostOptions, picked.join('|')]);

    return (
        <HostMenu
            label={hostButtonLabel(picked)}
            options={options}
            picked={picked}
            onChange={(hosts) => setServiceHosts(service, hosts)}
            allLabel="All hosts"
            emptyText={serviceHostsLoading ? 'Loading hosts…' : 'No hosts in this time range.'}
            title={
                picked.length > 0
                    ? `Filtering this dashboard to ${plural(picked.length, 'host')} — click to change`
                    : 'Host: showing all hosts — click to filter'
            }
        />
    );
};
