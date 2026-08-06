/**
 * The signing dentist's name, remembered in this browser.
 *
 * Shared by the sign-off panel and the settings page so both read and write the
 * same key — otherwise editing it in one place silently leaves the other stale.
 */
import { useEffect, useState } from 'react';

export const DOCTOR_NAME_KEY = 'smileai.doctorName';

export function useDoctorName() {
  const [doctorName, setDoctorName] = useState(
    () => localStorage.getItem(DOCTOR_NAME_KEY) || '',
  );

  useEffect(() => {
    localStorage.setItem(DOCTOR_NAME_KEY, doctorName);
  }, [doctorName]);

  return [doctorName, setDoctorName];
}
