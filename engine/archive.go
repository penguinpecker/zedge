package engine

import "encoding/json"

// ArchiveDigest authenticates a record against the previous archive root and
// ordinal. The outer engine journal/state commitment must also be verified.
func ArchiveDigest(record RoundArchive) (string, error) {
	if record.Count == 0 || !isHex(record.PreviousRoot, 64) {
		return "", fail("invalid archive record")
	}
	b, err := json.Marshal(struct {
		Domain       string `json:"domain"`
		Count        uint64 `json:"count"`
		PreviousRoot string `json:"previousRoot"`
		Round        Round  `json:"round"`
	}{"ZEDGE_ROUND_ARCHIVE_V3", record.Count, record.PreviousRoot, record.Round})
	if err != nil {
		return "", err
	}
	return hash(b), nil
}

func (s *State) archiveRound(c Command, receipt *Receipt) error {
	round, err := s.round(c.RoundID)
	if err != nil {
		return err
	}
	if (round.Status != "resolved" && round.Status != "void") || round.Locked != 0 || round.UpSupply != 0 || round.DownSupply != 0 || s.ArchivedRounds >= MaxAtoms {
		return fail("round is not fully redeemed and terminal")
	}
	for _, o := range s.Orders {
		if o.RoundID == round.ID && o.Remaining > 0 {
			return fail("round has active orders")
		}
	}
	for _, a := range s.Accounts {
		for _, h := range a.Holdings {
			if h.RoundID == round.ID && (h.Up != 0 || h.Down != 0 || h.ReservedUp != 0 || h.ReservedDown != 0) {
				return fail("round has unredeemed holdings")
			}
		}
	}
	record := RoundArchive{Count: s.ArchivedRounds + 1, PreviousRoot: s.ArchiveRoot, Round: *round}
	record.Hash, err = ArchiveDigest(record)
	if err != nil {
		return err
	}
	for i := range s.Accounts {
		a := &s.Accounts[i]
		for j := range a.Holdings {
			if a.Holdings[j].RoundID == round.ID {
				a.Holdings = append(a.Holdings[:j], a.Holdings[j+1:]...)
				break
			}
		}
	}
	for i := range s.Rounds {
		if s.Rounds[i].ID == round.ID {
			s.Rounds = append(s.Rounds[:i], s.Rounds[i+1:]...)
			break
		}
	}
	s.ArchivedRounds = record.Count
	s.ArchiveRoot = record.Hash
	receipt.RoundID = record.Round.ID
	receipt.Archive = &record
	receipt.Status = "archived"
	return nil
}
