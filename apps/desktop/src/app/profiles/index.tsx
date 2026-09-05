import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CodeEditor } from '@/components/chat/code-editor'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { ProfileGlyph } from '@/components/ui/profile-glyph'
import { getProfileSoul, type ProfileInfo, updateProfileSoul } from '@/hermes'
import { useI18n } from '@/i18n'
import { displayPath } from '@/lib/display-path'
import { AlertTriangle, Save } from '@/lib/icons'
import { resolveProfileColor } from '@/lib/profile-color'
import { normalize } from '@/lib/text'
import { notify, notifyError } from '@/store/notifications'
import { $profileColors, refreshProfiles } from '@/store/profile'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import {
  Panel,
  PanelAddButton,
  PanelBody,
  PanelDetail,
  PanelEmpty,
  PanelHeader,
  PanelList,
  PanelListRow,
  type PanelMenuItem,
  PanelMeta,
  PanelPill,
  PanelSectionLabel
} from '../overlays/panel'

import { CreateProfileDialog } from './create-profile-dialog'
import { DeleteProfileDialog } from './delete-profile-dialog'
import { RenameProfileDialog } from './rename-profile-dialog'

interface ProfilesViewProps {
  onClose: () => void
}

interface ManagedProfilePresentation {
  agentDisplayName?: null | string
  profileName: null | string
}

export function resolveManagedProfileDisplayName(
  profileName: string,
  presentation: ManagedProfilePresentation | null
): string {
  const canonicalProfileName = presentation?.profileName?.trim()
  const displayName = presentation?.agentDisplayName?.trim()

  return canonicalProfileName && displayName && profileName === canonicalProfileName ? displayName : profileName
}

export function ProfilesView({ onClose }: ProfilesViewProps) {
  const { t } = useI18n()
  const p = t.profiles
  const [profiles, setProfiles] = useState<null | ProfileInfo[]>(null)
  const [selectedName, setSelectedName] = useState<null | string>(null)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingRename, setPendingRename] = useState<null | ProfileInfo>(null)
  const [pendingDelete, setPendingDelete] = useState<null | ProfileInfo>(null)
  const [managedPresentation, setManagedPresentation] = useState<ManagedProfilePresentation | null>(null)
  const refreshInFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      return
    }

    refreshInFlight.current = true

    try {
      // Keep managed enrollment reads serialized with the profile list so a
      // single 401 recovery cannot mix values from different generations.
      const list = await refreshProfiles()

      const activeProfileResult = window.hermesDesktop?.profile?.get
        ? await window.hermesDesktop.profile
            .get()
            .then(value => ({ ok: true as const, value }))
            .catch(() => ({ ok: false as const }))
        : { ok: false as const }

      let nextManagedPresentation: ManagedProfilePresentation | null | undefined

      if (activeProfileResult.ok) {
        const statusResult = window.hermesDesktop?.eva?.status
          ? await window.hermesDesktop.eva
              .status()
              .then(value => ({ ok: true as const, value }))
              .catch(() => ({ ok: false as const }))
          : { ok: false as const }

        if (statusResult.ok) {
          const profileName =
            typeof activeProfileResult.value?.profile === 'string' ? activeProfileResult.value.profile.trim() : ''

          nextManagedPresentation =
            statusResult.value?.managed && profileName
              ? { agentDisplayName: statusResult.value.agentDisplayName, profileName }
              : null
        }
      }

      if (nextManagedPresentation !== undefined) {
        setManagedPresentation(nextManagedPresentation)
      }

      setProfiles(list)
      setSelectedName(current => {
        if (current && list.some(p => p.name === current)) {
          return current
        }

        return list.find(p => p.is_default)?.name ?? list[0]?.name ?? null
      })
    } catch (err) {
      notifyError(err, p.failedLoad)
    } finally {
      refreshInFlight.current = false
    }
  }, [p])

  useRefreshHotkey(refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selected = useMemo(() => {
    if (!profiles) {
      return null
    }

    return profiles.find(p => p.name === selectedName) ?? profiles[0] ?? null
  }, [profiles, selectedName])

  const visibleProfiles = useMemo(() => {
    const q = normalize(query)

    if (!profiles || !q) {
      return profiles ?? []
    }

    return profiles.filter(profile => {
      const displayName = resolveManagedProfileDisplayName(profile.name, managedPresentation)

      return (
        profile.name.toLowerCase().includes(q) ||
        displayName.toLowerCase().includes(q) ||
        (profile.model ?? '').toLowerCase().includes(q)
      )
    })
  }, [managedPresentation, profiles, query])

  // The shared Create/Rename dialogs own the createProfile / renameProfile /
  // updateProfileSoul calls; the panel just selects the resulting profile and
  // re-pulls the list.
  const selectAndRefresh = useCallback(
    async (name: string) => {
      setSelectedName(name)
      await refresh()
    },
    [refresh]
  )

  return (
    <Panel closeLabel={p.close} onClose={onClose}>
      {!profiles ? (
        <PageLoader label={p.loading} />
      ) : profiles.length === 0 ? (
        <PanelEmpty
          action={
            <Button onClick={() => setCreateOpen(true)} size="sm">
              {p.newProfile}
            </Button>
          }
          description={p.createDesc}
          icon="organization"
          title={p.noProfiles}
        />
      ) : (
        <>
          <PanelHeader subtitle={p.count(profiles.length)} title={p.title} />
          <PanelBody>
            <PanelList
              onSearchChange={setQuery}
              searchLabel={p.search}
              searchPlaceholder={p.search}
              searchValue={query}
            >
              {visibleProfiles.map(profile => (
                <ProfileRow
                  active={selected?.name === profile.name}
                  displayName={resolveManagedProfileDisplayName(profile.name, managedPresentation)}
                  key={profile.name}
                  menuItems={
                    profile.is_default
                      ? // Renaming the default profile sets a presentation-only
                        // display name (the canonical id stays "default").
                        [{ icon: 'edit', label: p.renameMenu, onSelect: () => setPendingRename(profile) }]
                      : [
                          { icon: 'edit', label: p.renameMenu, onSelect: () => setPendingRename(profile) },
                          {
                            icon: 'trash',
                            label: t.common.delete,
                            onSelect: () => setPendingDelete(profile),
                            tone: 'danger'
                          }
                        ]
                  }
                  onSelect={() => setSelectedName(profile.name)}
                  profile={profile}
                />
              ))}
              <PanelAddButton label={p.newProfile} onClick={() => setCreateOpen(true)} />
            </PanelList>

            {selected ? (
              <ProfileDetail
                displayName={resolveManagedProfileDisplayName(selected.name, managedPresentation)}
                key={selected.name}
                profile={selected}
              />
            ) : (
              <PanelEmpty description={p.selectPrompt} icon="account" />
            )}
          </PanelBody>
        </>
      )}

      <RenameProfileDialog
        currentName={pendingRename?.name ?? ''}
        isDefault={pendingRename?.is_default ?? false}
        onClose={() => setPendingRename(null)}
        onRenamed={selectAndRefresh}
        open={pendingRename !== null}
      />

      <CreateProfileDialog
        onClose={() => setCreateOpen(false)}
        onCreated={selectAndRefresh}
        open={createOpen}
        profiles={profiles ?? []}
      />

      <DeleteProfileDialog
        onClose={() => setPendingDelete(null)}
        onDeleted={async () => {
          setSelectedName(null)
          await refresh()
        }}
        open={pendingDelete !== null}
        profile={pendingDelete}
      />
    </Panel>
  )
}

function ProfileRow({
  active,
  displayName,
  menuItems,
  onSelect,
  profile
}: {
  active: boolean
  displayName: string
  menuItems: PanelMenuItem[]
  onSelect: () => void
  profile: ProfileInfo
}) {
  const colors = useStore($profileColors)

  return (
    <PanelListRow
      active={active}
      lead={
        <ProfileGlyph
          aria-hidden="true"
          color={resolveProfileColor(profile.name, colors)}
          isDefault={profile.is_default}
          name={displayName}
        />
      }
      menuItems={menuItems}
      menuLabel={displayName}
      onSelect={onSelect}
      rowKey={profile.name}
      title={displayName}
    />
  )
}

function ProfileDetail({ displayName, profile }: { displayName: string; profile: ProfileInfo }) {
  const { t } = useI18n()
  const p = t.profiles

  return (
    <PanelDetail>
      <header className="space-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[0.95rem] font-semibold tracking-tight text-foreground">{displayName}</h3>
            {profile.is_default && <PanelPill tone="good">{p.defaultBadge}</PanelPill>}
            {profile.has_env && <PanelPill tone="muted">.env</PanelPill>}
          </div>
          <p
            className="mt-1 truncate font-mono text-[0.66rem] text-muted-foreground/55"
            title={displayPath(profile.path)}
          >
            {displayPath(profile.path)}
          </p>
        </div>

        <PanelMeta
          rows={[
            {
              label: p.modelLabel,
              value: profile.model ? (
                <span className="font-mono">
                  {profile.model}
                  {profile.provider ? <span className="text-muted-foreground/55"> · {profile.provider}</span> : null}
                </span>
              ) : (
                <span className="text-muted-foreground/55">{p.notSet}</span>
              )
            },
            { label: p.skillsLabel, value: profile.skill_count }
          ]}
        />
      </header>

      <SoulEditor profileName={profile.name} />
    </PanelDetail>
  )
}

function SoulEditor({ profileName }: { profileName: string }) {
  const { t } = useI18n()
  const p = t.profiles
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const requestRef = useRef<string>(profileName)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    requestRef.current = profileName
    setLoading(true)
    setError(null)
    setContent('')
    setOriginal('')

    void (async () => {
      try {
        const soul = await getProfileSoul(profileName)

        if (requestRef.current === profileName) {
          setContent(soul.content)
          setOriginal(soul.content)
        }
      } catch (err) {
        if (requestRef.current === profileName) {
          setError(err instanceof Error ? err.message : p.failedLoadSoul)
        }
      } finally {
        if (requestRef.current === profileName) {
          setLoading(false)
        }
      }
    })()
  }, [p, profileName])

  const dirty = content !== original

  async function handleSave() {
    setSaving(true)
    setError(null)

    try {
      await updateProfileSoul(profileName, content)
      setOriginal(content)
      notify({ kind: 'success', title: p.soulSaved, message: profileName })
    } catch (err) {
      setError(err instanceof Error ? err.message : p.failedSaveSoul)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <PanelSectionLabel className="text-[0.7rem] tracking-[0.14em]">SOUL.md</PanelSectionLabel>
          <p className="text-xs text-muted-foreground">{p.soulDesc}</p>
        </div>
        {dirty && <span className="text-[0.65rem] text-muted-foreground">{p.unsavedChanges}</span>}
      </div>

      {loading ? (
        <PageLoader className="min-h-44" label={p.loadingSoul} />
      ) : (
        <div className="min-h-48">
          <CodeEditor
            filePath="SOUL.md"
            framed
            initialValue={content}
            key={profileName}
            onChange={setContent}
            onSave={() => void handleSave()}
          />
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex justify-end">
        <Button disabled={!dirty || saving || loading} onClick={() => void handleSave()} size="sm">
          <Save />
          {saving ? p.saving : p.saveSoul}
        </Button>
      </div>
    </section>
  )
}
