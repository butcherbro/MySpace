//! Hybrid logical clock (ADR-0011 Decision 2).
//!
//! An [`Hlc`] is `(wall_ms, counter, device_id)`. It orders every journaled
//! change across devices without trusting wall clocks: a device's clock never
//! goes backwards (a physical clock that jumps back only bumps the counter),
//! and receiving a remote change moves the local clock past it, so a local
//! edit made after seeing a remote one always sorts after it. The device id
//! breaks ties, which makes the order total.
//!
//! Wire and storage form: `{wall_ms:015}-{counter:05}-{device_id}`. Fixed
//! width, so byte-wise string comparison IS the clock order (SQL `ORDER BY
//! hlc`, `MAX(hlc)` and `BTreeMap<String, _>` all agree with [`Ord`]).
//!
//! The last clock this device issued is persisted in `local_meta.hlc_last`
//! and read/advanced inside the writer's `BEGIN IMMEDIATE` transaction
//! ([`next_local`], [`observe_remote`]), so two processes writing the same
//! database (the app and the MCP server) never issue the same value.

use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::domain::errors::WorkspaceError;

/// `local_meta` key holding the last HLC this device issued.
pub const HLC_LAST_KEY: &str = "hlc_last";

/// Largest counter the 5-digit encoding can hold. Reaching it borrows one
/// millisecond from the future instead of overflowing the fixed width.
pub const MAX_COUNTER: u32 = 99_999;

/// Largest wall time the 15-digit encoding can hold (year ~33658).
const MAX_WALL_MS: u64 = 999_999_999_999_999;

/// One hybrid-logical-clock value. Ordered by `(wall_ms, counter, device_id)`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Hlc {
    pub wall_ms: u64,
    pub counter: u32,
    pub device_id: String,
}

impl Hlc {
    /// The zero clock of `device_id` (below every issued value).
    pub fn zero(device_id: &str) -> Self {
        Self {
            wall_ms: 0,
            counter: 0,
            device_id: device_id.to_string(),
        }
    }

    /// Next local clock after `last`, at physical time `physical_ms`.
    /// Strictly greater than `last` even when the physical clock went
    /// backwards or did not advance.
    pub fn tick(last: &Hlc, physical_ms: u64, device_id: &str) -> Hlc {
        let (wall_ms, counter) = if physical_ms > last.wall_ms {
            (physical_ms, 0)
        } else {
            (last.wall_ms, last.counter + 1)
        };
        normalize(wall_ms, counter, device_id)
    }

    /// Next local clock after `last`, at the system time.
    pub fn now(last: &Hlc, device_id: &str) -> Hlc {
        Self::tick(last, physical_now_ms(), device_id)
    }

    /// The local clock after receiving `remote`, at physical time
    /// `physical_ms`: strictly greater than both `last` and `remote`.
    pub fn merge(last: &Hlc, remote: &Hlc, physical_ms: u64, device_id: &str) -> Hlc {
        let wall_ms = physical_ms.max(last.wall_ms).max(remote.wall_ms);
        let counter = if wall_ms == last.wall_ms && wall_ms == remote.wall_ms {
            last.counter.max(remote.counter) + 1
        } else if wall_ms == last.wall_ms {
            last.counter + 1
        } else if wall_ms == remote.wall_ms {
            remote.counter + 1
        } else {
            0
        };
        normalize(wall_ms, counter, device_id)
    }

    /// [`Hlc::merge`] at the system time.
    pub fn receive(last: &Hlc, remote: &Hlc, device_id: &str) -> Hlc {
        Self::merge(last, remote, physical_now_ms(), device_id)
    }

    /// The fixed-width, lexicographically sortable encoding.
    pub fn encode(&self) -> String {
        self.to_string()
    }
}

/// Keeps the counter inside its 5-digit field by carrying into the wall time.
fn normalize(wall_ms: u64, counter: u32, device_id: &str) -> Hlc {
    let (wall_ms, counter) = if counter > MAX_COUNTER {
        (wall_ms + 1, 0)
    } else {
        (wall_ms, counter)
    };
    Hlc {
        wall_ms: wall_ms.min(MAX_WALL_MS),
        counter,
        device_id: device_id.to_string(),
    }
}

fn physical_now_ms() -> u64 {
    crate::db::migrations::now_millis().max(0) as u64
}

impl Ord for Hlc {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.wall_ms, self.counter, &self.device_id).cmp(&(
            other.wall_ms,
            other.counter,
            &other.device_id,
        ))
    }
}

impl PartialOrd for Hlc {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Hlc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:015}-{:05}-{}",
            self.wall_ms, self.counter, self.device_id
        )
    }
}

impl FromStr for Hlc {
    type Err = WorkspaceError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let invalid = || WorkspaceError::ConstraintViolation(format!("invalid hlc: {s}"));
        let wall = s.get(0..15).ok_or_else(invalid)?;
        let counter = s.get(16..21).ok_or_else(invalid)?;
        let device_id = s.get(22..).ok_or_else(invalid)?;
        if s.as_bytes().get(15) != Some(&b'-')
            || s.as_bytes().get(21) != Some(&b'-')
            || device_id.is_empty()
            || !wall.bytes().all(|b| b.is_ascii_digit())
            || !counter.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(invalid());
        }
        Ok(Hlc {
            wall_ms: wall.parse().map_err(|_| invalid())?,
            counter: counter.parse().map_err(|_| invalid())?,
            device_id: device_id.to_string(),
        })
    }
}

impl Serialize for Hlc {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.encode())
    }
}

impl<'de> Deserialize<'de> for Hlc {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

/// The last clock this device issued (the zero clock when none yet).
pub fn load_last(conn: &Connection, device_id: &str) -> Result<Hlc, WorkspaceError> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM local_meta WHERE key = ?1",
            [HLC_LAST_KEY],
            |r| r.get(0),
        )
        .optional()?;
    match stored {
        Some(text) => {
            let mut last: Hlc = text.parse()?;
            // After a device-identity rotation (ADR-0012) the stored clock
            // still carries the previous id; its time part is what matters.
            last.device_id = device_id.to_string();
            Ok(last)
        }
        None => Ok(Hlc::zero(device_id)),
    }
}

fn store_last(conn: &Connection, hlc: &Hlc) -> Result<(), WorkspaceError> {
    conn.execute(
        "INSERT INTO local_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![HLC_LAST_KEY, hlc.encode()],
    )?;
    Ok(())
}

/// Issues the next local clock and persists it. Must run inside the writer's
/// transaction (the read-modify-write is what the IMMEDIATE lock protects).
pub fn next_local(conn: &Connection, device_id: &str) -> Result<Hlc, WorkspaceError> {
    let next = Hlc::now(&load_last(conn, device_id)?, device_id);
    store_last(conn, &next)?;
    Ok(next)
}

/// Advances this device's clock past a received `remote` clock.
pub fn observe_remote(
    conn: &Connection,
    device_id: &str,
    remote: &Hlc,
) -> Result<(), WorkspaceError> {
    let next = Hlc::receive(&load_last(conn, device_id)?, remote, device_id);
    store_last(conn, &next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hlc(wall_ms: u64, counter: u32, device: &str) -> Hlc {
        Hlc {
            wall_ms,
            counter,
            device_id: device.into(),
        }
    }

    #[test]
    fn encoding_round_trips_and_sorts_like_ord() {
        let values = vec![
            hlc(5, 0, "b"),
            hlc(5, 0, "a"),
            hlc(1_700_000_000_000, 3, "dev"),
            hlc(12, 99_999, "z"),
            hlc(13, 0, "a"),
            hlc(5, 1, "a"),
        ];
        for v in &values {
            assert_eq!(v.encode().parse::<Hlc>().unwrap(), *v);
        }
        let mut by_ord = values.clone();
        by_ord.sort();
        let mut by_text: Vec<String> = values.iter().map(Hlc::encode).collect();
        by_text.sort();
        assert_eq!(
            by_ord.iter().map(Hlc::encode).collect::<Vec<_>>(),
            by_text,
            "string order equals clock order"
        );
        assert_eq!(hlc(7, 2, "dev").encode(), "000000000000007-00002-dev");
    }

    #[test]
    fn rejects_malformed_text() {
        for bad in [
            "",
            "12-00000-a",
            "000000000000007-0000-a",
            "000000000000007-00002-",
            "00000000000000x-00002-a",
            "000000000000007_00002-a",
        ] {
            assert!(bad.parse::<Hlc>().is_err(), "{bad}");
        }
    }

    #[test]
    fn tick_is_monotonic_when_the_clock_goes_backwards() {
        let mut last = Hlc::zero("a");
        let mut seen = Vec::new();
        for physical in [100, 100, 90, 50, 101, 101, 20] {
            let next = Hlc::tick(&last, physical, "a");
            assert!(next > last, "{next} > {last}");
            seen.push(next.clone());
            last = next;
        }
        assert_eq!(seen[1], hlc(100, 1, "a"));
        assert_eq!(seen[3], hlc(100, 3, "a"), "wall time never moves back");
        assert_eq!(seen[4], hlc(101, 0, "a"));
        assert_eq!(seen[6], hlc(101, 2, "a"));
    }

    #[test]
    fn counter_overflow_carries_into_wall_time() {
        let next = Hlc::tick(&hlc(10, MAX_COUNTER, "a"), 5, "a");
        assert_eq!(next, hlc(11, 0, "a"));
        assert!(next > hlc(10, MAX_COUNTER, "a"));
    }

    #[test]
    fn receive_advances_past_the_remote_clock() {
        let local = hlc(100, 4, "a");
        // Remote far ahead of both clocks.
        let remote = hlc(500, 7, "b");
        let merged = Hlc::merge(&local, &remote, 200, "a");
        assert_eq!(merged, hlc(500, 8, "a"));
        assert!(merged > remote && merged > local);
        // The next local tick stays after the remote even if physical time
        // is still behind it.
        assert!(Hlc::tick(&merged, 300, "a") > remote);
        // Same wall on all three: max counter + 1.
        assert_eq!(
            Hlc::merge(&hlc(9, 3, "a"), &hlc(9, 5, "b"), 9, "a"),
            hlc(9, 6, "a")
        );
        // Physical time ahead of both: counter resets.
        assert_eq!(
            Hlc::merge(&hlc(9, 3, "a"), &hlc(9, 5, "b"), 20, "a"),
            hlc(20, 0, "a")
        );
        // Local ahead of the remote.
        assert_eq!(
            Hlc::merge(&hlc(30, 3, "a"), &hlc(9, 5, "b"), 20, "a"),
            hlc(30, 4, "a")
        );
    }

    #[test]
    fn device_id_breaks_ties() {
        assert!(hlc(1, 1, "a") < hlc(1, 1, "b"));
        assert!(hlc(1, 1, "b") < hlc(1, 2, "a"));
        assert!(hlc(1, 9, "b") < hlc(2, 0, "a"));
    }

    #[test]
    fn persisted_clock_is_strictly_increasing_across_calls() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE local_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        let a = next_local(&conn, "dev").unwrap();
        let b = next_local(&conn, "dev").unwrap();
        assert!(b > a);
        let far = hlc(a.wall_ms + 10_000_000, 3, "other");
        observe_remote(&conn, "dev", &far).unwrap();
        let c = next_local(&conn, "dev").unwrap();
        assert!(c > far, "{c} > {far}");
        assert_eq!(c.device_id, "dev");
    }
}
