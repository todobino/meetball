import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { collection, doc, getDoc, getDocs, orderBy, query, setDoc } from 'firebase/firestore'
import { db } from './lib/firebase'
import './App.css'

type Route =
  | { type: 'create' }
  | { type: 'respond'; slug: string }
  | { type: 'host'; slug: string }

type MeetingResponse = {
  id: string
  name: string
  email?: string
  slotIds: string[]
  submittedAt: string
  deviceId: string
}

type Meeting = {
  slug: string
  title: string
  description: string
  timeZone: string
  windowStart: string
  windowEnd: string
  durationMinutes: number
  dates: string[]
  createdAt: string
  ownerDeviceId: string
  responses: MeetingResponse[]
}

type SlotDefinition = {
  id: string
  dateKey: string
  startMinutes: number
  endMinutes: number
}

type CalendarMonth = {
  label: string
  key: string
  cells: Array<string | null>
}

type SelectOption = {
  value: string
  label: string
}

type MeetingDocument = Omit<Meeting, 'responses'>

const DEVICE_ID_STORAGE_KEY = 'meetball:device-id:v1'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DURATION_OPTIONS = [15, 30, 45, 60]

function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))
  const [activeMeeting, setActiveMeeting] = useState<Meeting | undefined>(undefined)
  const [isMeetingLoading, setIsMeetingLoading] = useState(false)
  const [meetingLoadError, setMeetingLoadError] = useState('')
  const [deviceId] = useState(() => ensureDeviceId())
  const [mobileActionRoot, setMobileActionRoot] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (route.type === 'create' && window.location.pathname === '/') {
      window.history.replaceState({}, '', '/new')
    }
  }, [route])

  useEffect(() => {
    if (route.type === 'create') {
      return
    }

    let isCancelled = false
    queueMicrotask(() => {
      if (isCancelled) {
        return
      }
      setIsMeetingLoading(true)
      setMeetingLoadError('')
      setActiveMeeting(undefined)
    })

    fetchMeetingFromFirestore(route.slug)
      .then((meeting) => {
        if (isCancelled) {
          return
        }
        setActiveMeeting(meeting)
      })
      .catch((error) => {
        console.error('Failed to load meeting from Firestore', error)
        if (isCancelled) {
          return
        }
        setMeetingLoadError('Unable to load this meeting right now. Please try again.')
      })
      .finally(() => {
        if (isCancelled) {
          return
        }
        setIsMeetingLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [route])

  const navigate = (nextRoute: Route) => {
    const nextPath = routeToPath(nextRoute)
    window.history.pushState({}, '', nextPath)
    setRoute(nextRoute)
  }

  return (
    <div className="app-shell">
      <div className="ambient-orb ambient-orb-left" aria-hidden="true" />
      <div className="ambient-orb ambient-orb-right" aria-hidden="true" />
      <div className="netting-overlay" aria-hidden="true" />

      <div className="app-frame">
        <header className="top-bar">
          <button
            type="button"
            className="brand"
            onClick={() => navigate({ type: 'create' })}
          >
            <span className="material-symbols-rounded brand-icon" aria-hidden="true">
              sports_volleyball
            </span>
            <span className="brand-label">Meetball</span>
          </button>
          <p className="top-bar-tagline">Easy, peasy, scheduling.</p>
          <button
            type="button"
            className="ghost-button new-meeting-button"
            onClick={() => navigate({ type: 'create' })}
          >
            <span className="material-symbols-rounded new-meeting-icon" aria-hidden="true">
              add
            </span>
            <span>New Meeting</span>
          </button>
        </header>

        <main className="main-content">
          {route.type === 'create' && (
            <CreateMeetingView
              meetings={{}}
              ownerDeviceId={deviceId}
              mobileActionRoot={mobileActionRoot}
              onCreate={async (meeting) => {
                const createdMeeting = await createMeetingInFirestore(meeting)
                navigate({ type: 'respond', slug: createdMeeting.slug })
              }}
            />
          )}

          {route.type !== 'create' && isMeetingLoading && (
            <section className="panel animate-in">
              <div className="panel-header">
                <p className="eyebrow">Loading Meeting</p>
                <h1>Fetching meeting details...</h1>
              </div>
            </section>
          )}

          {route.type !== 'create' && !isMeetingLoading && Boolean(meetingLoadError) && (
            <section className="panel animate-in">
              <div className="panel-header">
                <p className="eyebrow">Connection Error</p>
                <h1>Could not load this meeting</h1>
                <p>{meetingLoadError}</p>
              </div>
              <div className="actions-row">
                <button type="button" className="primary-button" onClick={() => navigate({ type: 'create' })}>
                  Back to Create
                </button>
              </div>
            </section>
          )}

          {route.type !== 'create' && !isMeetingLoading && !meetingLoadError && !activeMeeting && (
            <NotFoundView onBack={() => navigate({ type: 'create' })} />
          )}

          {route.type !== 'create' && !isMeetingLoading && activeMeeting && (
            <PublicMeetingView
              key={activeMeeting.slug}
              meeting={activeMeeting}
              mobileActionRoot={mobileActionRoot}
              onSubmitResponse={async (response) => {
                await addMeetingResponseToFirestore(activeMeeting.slug, response)
                setActiveMeeting((previous) => {
                  if (!previous) {
                    return previous
                  }
                  return {
                    ...previous,
                    responses: [...previous.responses, response],
                  }
                })
              }}
            />
          )}
        </main>
        <div id="mobile-action-root" className="mobile-action-root" ref={setMobileActionRoot} />
      </div>
    </div>
  )
}

type CreateMeetingViewProps = {
  meetings: Record<string, Meeting>
  ownerDeviceId: string
  mobileActionRoot: HTMLElement | null
  onCreate: (meeting: Meeting) => Promise<void>
}

function CreateMeetingView({ meetings, ownerDeviceId, mobileActionRoot, onCreate }: CreateMeetingViewProps) {
  const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const [step, setStep] = useState<1 | 2>(1)
  const [title, setTitle] = useState('')
  const [windowStart, setWindowStart] = useState('09:00')
  const [windowEnd, setWindowEnd] = useState('17:00')
  const [timeZone, setTimeZone] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(30)
  const [selectedDates, setSelectedDates] = useState<string[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const timeZoneOptions = useMemo(() => getSupportedTimeZones(), [])
  const timeSelectOptions = useMemo<SelectOption[]>(() => buildTimeOptions(30), [])
  const durationSelectOptions = useMemo<SelectOption[]>(
    () =>
      DURATION_OPTIONS.map((option) => ({
        value: String(option),
        label: `${option} minutes`,
      })),
    [],
  )
  const timeZoneSelectOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: `Auto (${defaultTimeZone})` },
      ...timeZoneOptions.map((zone) => ({ value: zone, label: zone })),
    ],
    [defaultTimeZone, timeZoneOptions],
  )
  const selectedDayTiles = useMemo(
    () =>
      [...selectedDates].sort().map((dateKey) => ({
        dateKey,
        weekday: formatColumnWeekday(dateKey),
        date: formatColumnDate(dateKey),
      })),
    [selectedDates],
  )
  const createFormId = 'create-meeting-form'

  const toggleDate = (dateKey: string) => {
    setSelectedDates((previous) => {
      if (previous.includes(dateKey)) {
        return previous.filter((value) => value !== dateKey)
      }
      return [...previous, dateKey].sort()
    })
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMessage('')

    const cleanTitle = title.trim()
    const startMinutes = timeToMinutes(windowStart)
    const endMinutes = timeToMinutes(windowEnd)

    if (!cleanTitle) {
      setErrorMessage('Add a meeting name before creating the link.')
      return
    }

    if (selectedDates.length === 0) {
      setErrorMessage('Pick at least one day on the calendar.')
      return
    }

    if (endMinutes <= startMinutes) {
      setErrorMessage('Meeting window end time must be after the start time.')
      return
    }

    if (endMinutes - startMinutes < durationMinutes) {
      setErrorMessage('Meeting window must be longer than your meeting length.')
      return
    }

    const slug = createUniqueSlug(meetings)
    const meeting: Meeting = {
      slug,
      title: cleanTitle,
      description: '',
      timeZone: timeZone || defaultTimeZone,
      windowStart,
      windowEnd,
      durationMinutes,
      dates: [...selectedDates].sort(),
      createdAt: new Date().toISOString(),
      ownerDeviceId,
      responses: [],
    }

    try {
      setIsSubmitting(true)
      await onCreate(meeting)
    } catch (error) {
      console.error('Failed to create meeting in Firestore', error)
      setErrorMessage('Could not create meeting right now. Please try again.')
      setIsSubmitting(false)
    }
  }

  const timeWindowSummary = `${formatMinutes(timeToMinutes(windowStart))} to ${formatMinutes(timeToMinutes(windowEnd))}`
  const durationSummary = `${durationMinutes}-minute meeting`
  const onContinue = () => {
    if (selectedDates.length === 0) {
      setErrorMessage('Pick at least one day on the calendar.')
      return
    }
    setErrorMessage('')
    setStep(2)
  }

  return (
    <section className="panel animate-in create-panel">
      <div className="panel-header create-header">
        <div className="create-title-wrap">
          <span className="create-step-icon" aria-hidden="true">
            {step}
          </span>
          <h1>{step === 1 ? 'Propose Dates' : 'Set Meeting Details'}</h1>
        </div>
        <div className="create-header-actions">
          {step === 1 && (
            <button
              type="button"
              className="primary-button nav-button create-top-continue-button"
              onClick={onContinue}
            >
              <span>Continue</span>
              <span className="material-symbols-rounded button-icon" aria-hidden="true">
                arrow_forward
              </span>
            </button>
          )}
          {step === 2 && (
            <>
              <button
                type="button"
                className="ghost-button nav-button create-top-back-button"
                onClick={() => setStep(1)}
              >
                <span className="material-symbols-rounded button-icon" aria-hidden="true">
                  arrow_back
                </span>
                <span>Back</span>
              </button>
              <button
                type="submit"
                form={createFormId}
                className="primary-button create-top-create-button"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Creating...' : 'Create Meeting Link'}
              </button>
            </>
          )}
        </div>
      </div>

      {step === 1 && (
        <div className="create-step-body create-step-body-step-one">
          <CalendarPicker selectedDates={selectedDates} onToggleDate={toggleDate} />

          {errorMessage && <p className="error-text">{errorMessage}</p>}

        </div>
      )}

      {step === 2 && (
        <form id={createFormId} className="meeting-form create-step-body create-step-body-step-two" onSubmit={onSubmit}>
          <div className="details-layout">
            <div className="form-grid details-form-grid">
              <label className="field field-row-name">
                <span>Meeting Name</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={90}
                  placeholder="Team Check-In"
                  required
                />
              </label>

              <div className="field field-row-length">
                <span>Meeting Length</span>
                <SelectMenu
                  ariaLabel="Meeting Length"
                  value={String(durationMinutes)}
                  options={durationSelectOptions}
                  onChange={(value) => setDurationMinutes(Number(value))}
                  triggerClassName="select-trigger"
                  menuClassName="select-menu-surface"
                  optionClassName="select-menu-option"
                />
              </div>

              <div className="field field-row-window-start">
                <span>Window Start</span>
                <SelectMenu
                  ariaLabel="Window Start"
                  value={windowStart}
                  options={timeSelectOptions}
                  onChange={setWindowStart}
                  triggerClassName="select-trigger"
                  menuClassName="select-menu-surface"
                  optionClassName="select-menu-option"
                />
              </div>

              <div className="field field-row-window-end">
                <span>Window End</span>
                <SelectMenu
                  ariaLabel="Window End"
                  value={windowEnd}
                  options={timeSelectOptions}
                  onChange={setWindowEnd}
                  triggerClassName="select-trigger"
                  menuClassName="select-menu-surface"
                  optionClassName="select-menu-option"
                />
              </div>

              <div className="field field-row-timezone">
                <span>Time Zone</span>
                <SelectMenu
                  ariaLabel="Time Zone"
                  value={timeZone}
                  options={timeZoneSelectOptions}
                  onChange={setTimeZone}
                  triggerClassName="select-trigger"
                  menuClassName="select-menu-surface"
                  optionClassName="select-menu-option"
                />
              </div>
            </div>

            <div className="details-summary-column">
              <aside className="details-summary-box">
                <p className="details-summary-title">Summary</p>
                <div className="details-summary-badges">
                  <div className="summary-window-block">
                    <span className="summary-window-label">Meeting Window</span>
                    <p className="summary-window-time">{timeWindowSummary}</p>
                    <p className="summary-window-duration">{durationSummary}</p>
                  </div>
                  <div className="summary-day-section">
                    <span className="summary-window-label">Proposed Days</span>
                    <div className="summary-day-rows">
                      {selectedDayTiles.map((dayTile) => (
                        <div key={dayTile.dateKey} className="summary-day-row">
                          <span className="summary-day-weekday">{dayTile.weekday}</span>
                          <span className="summary-day-date">{dayTile.date}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          </div>

          {errorMessage && <p className="error-text">{errorMessage}</p>}
        </form>
      )}

      {step === 1 && (
        mobileActionRoot &&
        createPortal(
          <div className="create-mobile-action-bar">
            <button
              type="button"
              className="primary-button nav-button create-mobile-continue-button"
              onClick={onContinue}
            >
              <span>Continue</span>
            </button>
          </div>,
          mobileActionRoot,
        )
      )}

      {step === 2 && (
        mobileActionRoot &&
        createPortal(
          <div className="create-mobile-action-bar create-mobile-action-bar-step-two">
            <button type="button" className="ghost-button nav-button create-mobile-back-button" onClick={() => setStep(1)}>
              <span className="material-symbols-rounded button-icon" aria-hidden="true">
                arrow_back
              </span>
              <span>Back</span>
            </button>
            <button
              type="submit"
              form={createFormId}
              className="primary-button create-mobile-create-button"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Creating...' : 'Create Meeting Link'}
            </button>
          </div>,
          mobileActionRoot,
        )
      )}
    </section>
  )
}

type CalendarPickerProps = {
  selectedDates: string[]
  onToggleDate: (dateKey: string) => void
}

function CalendarPicker({ selectedDates, onToggleDate }: CalendarPickerProps) {
  const selected = useMemo(() => new Set(selectedDates), [selectedDates])
  const todayKey = toDateKey(new Date())
  const currentMonthStart = useMemo(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  }, [])
  const [visibleMonth, setVisibleMonth] = useState<Date>(currentMonthStart)
  const month = useMemo(() => buildCalendarMonth(visibleMonth), [visibleMonth])
  const disablePrevious =
    visibleMonth.getFullYear() === currentMonthStart.getFullYear() &&
    visibleMonth.getMonth() === currentMonthStart.getMonth()

  return (
    <section className="calendar-panel calendar-panel-large">
      <div className="calendar-header-row">
        <button
          type="button"
          className="calendar-header-arrow"
          onClick={() => {
            if (disablePrevious) {
              return
            }
            setVisibleMonth(
              (previous) => new Date(previous.getFullYear(), previous.getMonth() - 1, 1),
            )
          }}
          disabled={disablePrevious}
          aria-label="Show previous month"
        >
          ‹
        </button>
        <h2 className="calendar-month-title">{month.label}</h2>
        <button
          type="button"
          className="calendar-header-arrow"
          onClick={() =>
            setVisibleMonth((previous) => new Date(previous.getFullYear(), previous.getMonth() + 1, 1))
          }
          aria-label="Show next month"
        >
          ›
        </button>
      </div>

      <div className="calendar-panel-body">
        <div className="weekday-row weekday-row-large" role="presentation">
          {WEEKDAY_LABELS.map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>

        <div className="calendar-grid calendar-grid-large">
          {month.cells.map((value, index) => {
            if (!value) {
              return <span key={`${month.key}-blank-${index}`} className="calendar-blank" />
            }

            const isPast = value < todayKey
            const isSelected = selected.has(value)

            return (
              <button
                key={value}
                type="button"
                className={`date-cell date-cell-large ${isSelected ? 'date-cell-selected' : ''}`}
                disabled={isPast}
                onClick={() => onToggleDate(value)}
                aria-pressed={isSelected}
                title={formatDayLabel(value)}
              >
                <span>{Number(value.slice(-2))}</span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

type PublicMeetingViewProps = {
  meeting: Meeting
  mobileActionRoot: HTMLElement | null
  onSubmitResponse: (response: MeetingResponse) => Promise<void>
}

function PublicMeetingView({ meeting, mobileActionRoot, onSubmitResponse }: PublicMeetingViewProps) {
  const [selectedSlotIds, setSelectedSlotIds] = useState<string[]>([])
  const [isAddingResponse, setIsAddingResponse] = useState(false)
  const [dragMode, setDragMode] = useState<'add' | 'remove' | null>(null)
  const [hoveredSlotId, setHoveredSlotId] = useState<string | null>(null)
  const [mobileFocusedSlotId, setMobileFocusedSlotId] = useState<string | null>(null)
  const [isMobileResponsesOpen, setIsMobileResponsesOpen] = useState(false)
  const [isMobileView, setIsMobileView] = useState(
    () => window.matchMedia('(max-width: 960px)').matches,
  )
  const [hoveredResponseId, setHoveredResponseId] = useState<string | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [selectionError, setSelectionError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [copiedStatus, setCopiedStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const shareLink = `${window.location.origin}/m/${meeting.slug}`
  const slots = useMemo(() => buildSlots(meeting), [meeting])
  const slotsByDate = useMemo(() => groupSlotsByDate(slots), [slots])
  const selectedSet = useMemo(() => new Set(selectedSlotIds), [selectedSlotIds])
  const activeResponsesSlotId =
    isMobileView && isMobileResponsesOpen ? mobileFocusedSlotId : hoveredSlotId
  const orderedDateKeys = useMemo(() => [...meeting.dates].sort(), [meeting.dates])
  const slotResponseIdsMap = useMemo(() => {
    const map = new Map<string, string[]>()
    meeting.responses.forEach((response) => {
      response.slotIds.forEach((slotId) => {
        const existing = map.get(slotId)
        if (existing) {
          existing.push(response.id)
        } else {
          map.set(slotId, [response.id])
        }
      })
    })
    return map
  }, [meeting.responses])
  const slotResponseCountMap = useMemo(() => {
    const map = new Map<string, number>()
    slotResponseIdsMap.forEach((value, key) => map.set(key, value.length))
    return map
  }, [slotResponseIdsMap])
  const maxSlotResponseCount = useMemo(() => {
    let maxCount = 0
    slotResponseCountMap.forEach((count) => {
      if (count > maxCount) {
        maxCount = count
      }
    })
    return maxCount
  }, [slotResponseCountMap])
  const hoveredSlotResponderIds = useMemo(
    () => new Set(activeResponsesSlotId ? slotResponseIdsMap.get(activeResponsesSlotId) || [] : []),
    [activeResponsesSlotId, slotResponseIdsMap],
  )
  const hoveredResponseSlotIds = useMemo(() => {
    if (!hoveredResponseId) {
      return new Set<string>()
    }
    const response = meeting.responses.find((item) => item.id === hoveredResponseId)
    return new Set(response?.slotIds || [])
  }, [hoveredResponseId, meeting.responses])

  useEffect(() => {
    const onPointerUp = () => setDragMode(null)
    window.addEventListener('pointerup', onPointerUp)
    return () => window.removeEventListener('pointerup', onPointerUp)
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 960px)')
    const onChange = (event: MediaQueryListEvent) => {
      setIsMobileView(event.matches)
      if (!event.matches) {
        setIsMobileResponsesOpen(false)
        setMobileFocusedSlotId(null)
      }
    }
    mediaQuery.addEventListener('change', onChange)
    return () => mediaQuery.removeEventListener('change', onChange)
  }, [])

  const applySelection = (slotId: string, mode: 'add' | 'remove') => {
    setSelectedSlotIds((previous) => {
      const exists = previous.includes(slotId)
      if (mode === 'add') {
        return exists ? previous : [...previous, slotId]
      }
      return exists ? previous.filter((value) => value !== slotId) : previous
    })
  }

  const onSlotPointerDown = (slotId: string) => {
    if (!isAddingResponse) {
      return
    }
    const mode: 'add' | 'remove' = selectedSet.has(slotId) ? 'remove' : 'add'
    setDragMode(mode)
    setSelectionError('')
    applySelection(slotId, mode)
  }

  const onSlotPointerEnter = (slotId: string) => {
    if (!dragMode || !isAddingResponse) {
      return
    }
    applySelection(slotId, dragMode)
  }

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink)
      setCopiedStatus('copied')
      window.setTimeout(() => setCopiedStatus('idle'), 1400)
    } catch {
      setCopiedStatus('failed')
      window.setTimeout(() => setCopiedStatus('idle'), 1700)
    }
  }

  const onResponseAction = () => {
    if (!isAddingResponse) {
      setIsAddingResponse(true)
      setSelectedSlotIds([])
      setSelectionError('')
      setStatusMessage('')
      setIsMobileResponsesOpen(false)
      setMobileFocusedSlotId(null)
      return
    }

    if (selectedSlotIds.length === 0) {
      setSelectionError('Select at least one slot before confirming.')
      return
    }

    setDialogError('')
    setSelectionError('')
    setIsDialogOpen(true)
  }

  const onCancelResponse = () => {
    setIsAddingResponse(false)
    setSelectedSlotIds([])
    setSelectionError('')
    setDialogError('')
    setCopiedStatus('idle')
  }

  const closeMobileResponsesDrawer = () => {
    setIsMobileResponsesOpen(false)
    setMobileFocusedSlotId(null)
  }

  const onSubmitDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleanName = name.trim()
    const cleanEmail = email.trim().toLowerCase()

    if (!cleanName) {
      setDialogError('Please add your name to confirm your response.')
      return
    }

    if (selectedSlotIds.length === 0) {
      setDialogError('Select at least one slot before confirming.')
      return
    }

    try {
      await onSubmitResponse({
        id: createRandomString(12),
        name: cleanName,
        ...(cleanEmail ? { email: cleanEmail } : {}),
        slotIds: [...selectedSlotIds].sort(),
        submittedAt: new Date().toISOString(),
        deviceId: ensureDeviceId(),
      })
    } catch (error) {
      console.error('Failed to submit meeting response', error)
      setDialogError('Could not save your response right now. Please try again.')
      return
    }

    setIsDialogOpen(false)
    setName('')
    setEmail('')
    setDialogError('')
    setSelectedSlotIds([])
    setIsAddingResponse(false)
    setSelectionError('')
    setStatusMessage(
      isMobileView
        ? 'Response saved!'
        : 'Response saved. Share this page link so others can add availability.',
    )
  }

  const responsesCountSplit = Boolean(activeResponsesSlotId) && meeting.responses.length > 0
  const responsesCountLabel = responsesCountSplit
    ? `${hoveredSlotResponderIds.size}/${meeting.responses.length}`
    : String(meeting.responses.length)
  const responsesQuality =
    responsesCountSplit && meeting.responses.length > 0
      ? hoveredSlotResponderIds.size / meeting.responses.length >= 0.66
        ? { label: 'Good', tone: 'good' as const }
        : hoveredSlotResponderIds.size / meeting.responses.length >= 0.5
          ? { label: 'Okay', tone: 'okay' as const }
          : { label: 'Poor', tone: 'poor' as const }
      : null

  const responsesPanelContent = (
    <>
      <div className="public-responses-header">
        <h2>Responses</h2>
        <div className="public-responses-controls">
          <div className="public-responses-meta">
            {responsesQuality && (
              <span className={`public-responses-quality is-${responsesQuality.tone}`}>
                {responsesQuality.label}
              </span>
            )}
            <span className={`public-responses-count ${responsesCountSplit ? 'is-split' : ''}`}>
              {responsesCountLabel}
            </span>
          </div>
          {isMobileResponsesOpen && (
            <button
              type="button"
              className="public-responses-close-button"
              onClick={closeMobileResponsesDrawer}
              aria-label="Close responses drawer"
            >
              <span className="material-symbols-rounded button-icon" aria-hidden="true">
                close
              </span>
            </button>
          )}
        </div>
      </div>
      {selectionError && <p className="error-text public-selection-error">{selectionError}</p>}

      <div className="public-responses-list">
        {meeting.responses.length === 0 && <p className="subtle-text">No responses yet.</p>}
        {meeting.responses.map((response) => (
          <article
            key={response.id}
            className={`public-response-card ${
              hoveredResponseId === response.id ? 'public-response-card-active' : ''
            } ${
              activeResponsesSlotId && !hoveredSlotResponderIds.has(response.id)
                ? 'public-response-card-dim'
                : ''
            } ${
              activeResponsesSlotId && hoveredSlotResponderIds.has(response.id)
                ? 'public-response-card-linked'
                : ''
            }`}
            onMouseEnter={() => setHoveredResponseId(response.id)}
            onMouseLeave={() => setHoveredResponseId(null)}
          >
            <p
              className={
                activeResponsesSlotId && hoveredSlotResponderIds.has(response.id)
                  ? 'public-response-name-highlighted'
                  : ''
              }
            >
              {response.name}
            </p>
            <span className="public-response-slot-count">{response.slotIds.length} Slots</span>
          </article>
        ))}
      </div>
      <div className="public-responses-footer">
        <p className="public-timezone-text">{formatTimeZoneLabel(meeting.timeZone)}</p>
      </div>
    </>
  )

  const copiedStatusToast =
    copiedStatus !== 'idle'
      ? (
          <div
            className={`public-share-feedback ${
              copiedStatus === 'failed' ? 'public-share-feedback-failed' : ''
            }`}
            role="status"
            aria-live="polite"
          >
            {copiedStatus === 'copied' ? 'Link Copied!' : 'Copy failed'}
          </div>
        )
      : null

  return (
    <section className="panel animate-in public-panel">
      <div className="public-top-row">
        <div className="public-title-block">
          <h1>{meeting.title}</h1>
          <p>Click respond to select your availability.</p>
        </div>
        <div className="public-share-action">
          {!isAddingResponse && (
            <button
              type="button"
              className="secondary-button nav-button public-share-button"
              onClick={copyShareLink}
              aria-label="Share meeting link"
            >
              <span className="material-symbols-rounded button-icon" aria-hidden="true">
                share
              </span>
            </button>
          )}
          {isAddingResponse && (
            <button
              type="button"
              className="secondary-button public-top-cancel-button"
              onClick={onCancelResponse}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            className={`public-response-action-button public-top-respond-button ${
              isAddingResponse ? 'is-confirm' : ''
            }`}
            onClick={onResponseAction}
          >
            <span className="material-symbols-rounded button-icon" aria-hidden="true">
              {isAddingResponse ? 'check' : 'add'}
            </span>
            <span>{isAddingResponse ? 'Confirm Response' : 'Respond'}</span>
          </button>
        </div>
      </div>
      {copiedStatusToast && createPortal(copiedStatusToast, document.body)}

      {statusMessage && (
        <div className="public-status-banner">
          <p>{statusMessage}</p>
          <div className="public-status-actions">
            <button type="button" className="secondary-button nav-button" onClick={copyShareLink}>
              <span className="material-symbols-rounded button-icon" aria-hidden="true">
                content_copy
              </span>
              <span>Copy Share Link</span>
            </button>
            <button
              type="button"
              className="status-close-button"
              onClick={() => setStatusMessage('')}
              aria-label="Dismiss response saved message"
            >
              <span className="material-symbols-rounded button-icon" aria-hidden="true">
                close
              </span>
            </button>
          </div>
        </div>
      )}

      <div className="public-layout">
        <section className="public-slots-section">
          <div
            className={`public-slots-grid ${isAddingResponse ? 'is-response-mode' : ''}`}
            style={{
              gridTemplateColumns: `repeat(${Math.max(orderedDateKeys.length, 1)}, minmax(8.5rem, 1fr))`,
            }}
            onPointerLeave={() => {
              setDragMode(null)
              setHoveredSlotId(null)
            }}
          >
            {orderedDateKeys.map((dateKey) => (
              <article key={dateKey} className="public-day-column">
                <div className="public-day-header">
                  <span className="public-day-weekday">{formatColumnWeekday(dateKey)}</span>
                  <span className="public-day-date">{formatColumnDate(dateKey)}</span>
                </div>
                <div className="public-day-slots">
                  {(slotsByDate[dateKey] || []).map((slot) => {
                    const selected = selectedSet.has(slot.id)
                    const responseCount = slotResponseCountMap.get(slot.id) || 0
                    let popularityClass = ''
                    if (responseCount > 0 && maxSlotResponseCount > 0) {
                      if (maxSlotResponseCount === 1) {
                        popularityClass = 'public-slot-popularity-low'
                      } else {
                        const popularityRatio = responseCount / maxSlotResponseCount
                        if (popularityRatio >= 0.75) {
                          popularityClass = 'public-slot-popularity-high'
                        } else if (popularityRatio >= 0.4) {
                          popularityClass = 'public-slot-popularity-medium'
                        } else {
                          popularityClass = 'public-slot-popularity-low'
                        }
                      }
                    }
                    const linkedToHoveredResponse = hoveredResponseSlotIds.has(slot.id)
                    const shouldDimForHoveredResponse =
                      Boolean(hoveredResponseId) && !linkedToHoveredResponse

                    return (
                      <button
                        key={slot.id}
                        type="button"
                        className={`public-slot ${selected ? 'public-slot-selected' : ''} ${
                          popularityClass
                        } ${
                          !isAddingResponse ? 'public-slot-readonly' : ''
                        } ${activeResponsesSlotId === slot.id ? 'public-slot-hovered' : ''} ${
                          linkedToHoveredResponse ? 'public-slot-linked-response' : ''
                        } ${shouldDimForHoveredResponse ? 'public-slot-dim' : ''
                        }`}
                        onPointerDown={() => onSlotPointerDown(slot.id)}
                        onPointerEnter={() => onSlotPointerEnter(slot.id)}
                        onMouseEnter={() => setHoveredSlotId(slot.id)}
                        onMouseLeave={() => setHoveredSlotId(null)}
                        onClick={() => {
                          if (isAddingResponse || !isMobileView) {
                            return
                          }
                          setMobileFocusedSlotId(slot.id)
                          setIsMobileResponsesOpen(true)
                        }}
                      >
                        {formatMinutes(slot.startMinutes)}
                      </button>
                    )
                  })}
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="public-responses-sidebar">{responsesPanelContent}</aside>
      </div>

      {isMobileResponsesOpen && !isAddingResponse && (
        <div className="public-responses-drawer-backdrop" onClick={closeMobileResponsesDrawer}>
          <aside
            className="public-responses-sidebar public-responses-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            {responsesPanelContent}
          </aside>
        </div>
      )}

      {mobileActionRoot &&
        createPortal(
          <div className="public-mobile-action-bar">
            {isAddingResponse && (
              <button type="button" className="secondary-button public-mobile-cancel-button" onClick={onCancelResponse}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className={`public-response-action-button public-mobile-respond-button ${
                isAddingResponse ? 'is-confirm' : ''
              }`}
              onClick={onResponseAction}
            >
              <span>{isAddingResponse ? 'Confirm Response' : 'Respond'}</span>
            </button>
          </div>,
          mobileActionRoot,
        )}

      {isDialogOpen && (
        <div className="response-dialog-backdrop" onClick={() => setIsDialogOpen(false)}>
          <div className="response-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>Confirm Response</h3>
            <p>Add your details to save selected slots.</p>

            <form onSubmit={onSubmitDialog} className="response-dialog-form">
              <label className="field">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your name"
                  required
                />
              </label>
              <label className="field">
                <span>Email (optional)</span>
                <input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </label>

              {dialogError && <p className="error-text">{dialogError}</p>}

              <div className="actions-row">
                <button type="button" className="ghost-button" onClick={() => setIsDialogOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-button">
                  Save Response
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  )
}

type NotFoundViewProps = {
  onBack: () => void
}

function NotFoundView({ onBack }: NotFoundViewProps) {
  return (
    <section className="panel animate-in">
      <div className="panel-header">
        <p className="eyebrow">Missing Meeting</p>
        <h1>That meeting link is invalid or expired</h1>
        <p>Create a new meeting to generate a fresh link.</p>
      </div>
      <div className="actions-row">
        <button type="button" className="primary-button" onClick={onBack}>
          Back to Create
        </button>
      </div>
    </section>
  )
}

type SelectMenuProps = {
  ariaLabel: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  leadingIcon?: string
  triggerClassName?: string
  menuClassName?: string
  optionClassName?: string
}

function SelectMenu({
  ariaLabel,
  value,
  options,
  onChange,
  leadingIcon,
  triggerClassName,
  menuClassName,
  optionClassName,
}: SelectMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null)
  const selectedOption = options.find((option) => option.value === value) || options[0]

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      const menu = menuRef.current
      const selected = selectedOptionRef.current
      if (!menu || !selected) {
        return
      }

      const targetScrollTop = selected.offsetTop - (menu.clientHeight - selected.clientHeight) / 2
      const maxScrollTop = menu.scrollHeight - menu.clientHeight
      menu.scrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop))
    })

    return () => window.cancelAnimationFrame(frame)
  }, [isOpen, options, value])

  return (
    <div className="select-menu" ref={rootRef}>
      <button
        type="button"
        className={triggerClassName || 'select-trigger'}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((previous) => !previous)}
      >
        <span className="select-trigger-main">
          {leadingIcon && (
            <span className="material-symbols-rounded select-trigger-icon" aria-hidden="true">
              {leadingIcon}
            </span>
          )}
          <span className="select-trigger-text">{selectedOption?.label}</span>
        </span>
        <span className="select-trigger-chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen && (
        <div className={menuClassName || 'select-menu-surface'} role="listbox" aria-label={ariaLabel} ref={menuRef}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              ref={option.value === value ? selectedOptionRef : undefined}
              className={`${optionClassName || 'select-menu-option'} ${
                option.value === value ? 'select-menu-option-active' : ''
              }`}
              onMouseDown={(event) => {
                event.preventDefault()
                onChange(option.value)
                setIsOpen(false)
              }}
              onClick={(event) => event.preventDefault()}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function buildTimeOptions(stepMinutes: number): SelectOption[] {
  const safeStep = Math.max(5, stepMinutes)
  const options: SelectOption[] = []

  for (let totalMinutes = 0; totalMinutes < 24 * 60; totalMinutes += safeStep) {
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    const value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    options.push({ value, label: formatMinutes(totalMinutes) })
  }

  return options
}

async function fetchMeetingFromFirestore(slug: string): Promise<Meeting | undefined> {
  const meetingRef = doc(db, 'meetings', slug)
  const meetingSnapshot = await getDoc(meetingRef)
  if (!meetingSnapshot.exists()) {
    return undefined
  }

  const data = meetingSnapshot.data() as Partial<MeetingDocument>
  const responsesSnapshot = await getDocs(
    query(collection(db, 'meetings', slug, 'responses'), orderBy('submittedAt', 'asc')),
  )

  const responses = responsesSnapshot.docs.map((responseDoc) => {
    const responseData = responseDoc.data() as Partial<MeetingResponse>
    return {
      id: typeof responseData.id === 'string' ? responseData.id : responseDoc.id,
      name: typeof responseData.name === 'string' ? responseData.name : 'Anonymous',
      email:
        typeof responseData.email === 'string' && responseData.email.length > 0
          ? responseData.email
          : undefined,
      slotIds: Array.isArray(responseData.slotIds)
        ? responseData.slotIds.filter((slotId): slotId is string => typeof slotId === 'string')
        : [],
      submittedAt:
        typeof responseData.submittedAt === 'string'
          ? responseData.submittedAt
          : new Date().toISOString(),
      deviceId: typeof responseData.deviceId === 'string' ? responseData.deviceId : '',
    }
  })

  return {
    slug,
    title: typeof data.title === 'string' ? data.title : 'Untitled Meeting',
    description: typeof data.description === 'string' ? data.description : '',
    timeZone: typeof data.timeZone === 'string' ? data.timeZone : 'UTC',
    windowStart: typeof data.windowStart === 'string' ? data.windowStart : '09:00',
    windowEnd: typeof data.windowEnd === 'string' ? data.windowEnd : '17:00',
    durationMinutes: typeof data.durationMinutes === 'number' ? data.durationMinutes : 30,
    dates: Array.isArray(data.dates)
      ? data.dates.filter((dateKey): dateKey is string => typeof dateKey === 'string')
      : [],
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    ownerDeviceId: typeof data.ownerDeviceId === 'string' ? data.ownerDeviceId : '',
    responses,
  }
}

async function createMeetingInFirestore(meeting: Meeting): Promise<Meeting> {
  let slug = meeting.slug

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const meetingRef = doc(db, 'meetings', slug)
    const existingMeetingSnapshot = await getDoc(meetingRef)
    if (existingMeetingSnapshot.exists()) {
      slug = createRandomString(10)
      continue
    }

    const meetingWithoutResponses: MeetingDocument = {
      slug,
      title: meeting.title,
      description: meeting.description,
      timeZone: meeting.timeZone,
      windowStart: meeting.windowStart,
      windowEnd: meeting.windowEnd,
      durationMinutes: meeting.durationMinutes,
      dates: [...meeting.dates],
      createdAt: meeting.createdAt,
      ownerDeviceId: meeting.ownerDeviceId,
    }
    await setDoc(meetingRef, meetingWithoutResponses)
    return {
      ...meetingWithoutResponses,
      responses: [],
    }
  }

  throw new Error('Could not generate a unique meeting slug.')
}

async function addMeetingResponseToFirestore(slug: string, response: MeetingResponse): Promise<void> {
  const responseRef = doc(db, 'meetings', slug, 'responses', response.id)
  await setDoc(responseRef, response)
}

function parseRoute(pathname: string): Route {
  const normalized = pathname.replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized === 'new') {
    return { type: 'create' }
  }

  const [head, slug] = normalized.split('/')

  if (head === 'm' && slug) {
    return { type: 'respond', slug }
  }

  if (head === 'host' && slug) {
    return { type: 'host', slug }
  }

  return { type: 'create' }
}

function routeToPath(route: Route): string {
  if (route.type === 'create') {
    return '/new'
  }

  if (route.type === 'respond') {
    return `/m/${route.slug}`
  }

  return `/host/${route.slug}`
}

function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildCalendarMonth(monthDate: Date): CalendarMonth {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
  const firstWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const cells: Array<string | null> = []
  for (let blank = 0; blank < firstWeekday; blank += 1) {
    cells.push(null)
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(toDateKey(new Date(year, month, day)))
  }

  return {
    label: new Intl.DateTimeFormat(undefined, {
      month: 'long',
      year: 'numeric',
    }).format(monthDate),
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    cells,
  }
}

function createUniqueSlug(meetings: Record<string, Meeting>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = createRandomString(10)
    if (!meetings[slug]) {
      return slug
    }
  }
  return `${createRandomString(8)}${Date.now().toString(36).slice(-4)}`
}

function createRandomString(length: number): string {
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const output: string[] = []

  if (window.crypto && window.crypto.getRandomValues) {
    const values = new Uint8Array(length)
    window.crypto.getRandomValues(values)

    for (let index = 0; index < values.length; index += 1) {
      output.push(characters[values[index] % characters.length])
    }

    return output.join('')
  }

  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * characters.length)
    output.push(characters[randomIndex])
  }

  return output.join('')
}

function buildSlots(meeting: Meeting): SlotDefinition[] {
  const startMinutes = timeToMinutes(meeting.windowStart)
  const endMinutes = timeToMinutes(meeting.windowEnd)

  if (endMinutes <= startMinutes || meeting.durationMinutes <= 0) {
    return []
  }

  const slots: SlotDefinition[] = []

  for (const dateKey of [...meeting.dates].sort()) {
    for (
      let cursor = startMinutes;
      cursor + meeting.durationMinutes <= endMinutes;
      cursor += meeting.durationMinutes
    ) {
      slots.push({
        id: `${dateKey}-${cursor}`,
        dateKey,
        startMinutes: cursor,
        endMinutes: cursor + meeting.durationMinutes,
      })
    }
  }

  return slots
}

function groupSlotsByDate(slots: SlotDefinition[]): Record<string, SlotDefinition[]> {
  return slots.reduce<Record<string, SlotDefinition[]>>((result, slot) => {
    if (!result[slot.dateKey]) {
      result[slot.dateKey] = []
    }
    result[slot.dateKey].push(slot)
    return result
  }, {})
}

function formatDayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatColumnDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
    .format(date)
    .toUpperCase()
}

function formatColumnWeekday(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  })
    .format(date)
    .toUpperCase()
}

function formatTimeZoneLabel(timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      timeZone,
      timeZoneName: 'short',
      hour: 'numeric',
      minute: '2-digit',
    })

    const zonePart = formatter
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value

    return zonePart ? `${timeZone} (${zonePart})` : timeZone
  } catch {
    return timeZone
  }
}

function formatMinutes(totalMinutes: number): string {
  const safeMinutes = Math.max(0, totalMinutes)
  const hour24 = Math.floor(safeMinutes / 60)
  const minutes = safeMinutes % 60
  const suffix = hour24 >= 12 ? 'PM' : 'AM'
  const hour12 = hour24 % 12 || 12
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`
}

function timeToMinutes(value: string): number {
  const [hoursText, minutesText] = value.split(':')
  const hours = Number(hoursText)
  const minutes = Number(minutesText)

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 0
  }

  return hours * 60 + minutes
}

function ensureDeviceId(): string {
  const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
  if (existing) {
    return existing
  }

  const created = createRandomString(14)
  window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created)
  return created
}

function getSupportedTimeZones(): string[] {
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (input: string) => string[]
  }

  const zones = intlWithSupportedValues.supportedValuesOf?.('timeZone')
  if (zones && zones.length > 0) {
    return zones
  }

  const fallback = [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Paris',
    'Asia/Tokyo',
    'Australia/Sydney',
  ]

  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (resolved && !fallback.includes(resolved)) {
    return [resolved, ...fallback]
  }

  return fallback
}

export default App
