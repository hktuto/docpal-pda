package com.honeywell;

import android.os.Parcel;
import android.os.Parcelable;

import java.util.Map;

/**
 * Faithful recreation of the Honeywell DCS wire Parcelable (reverse-engineered
 * from DataCollectionService.apk). Must live in package com.honeywell and
 * describeContents() must return 1 so parcel resolution on the service side
 * matches byte-for-byte.
 */
public class Message implements Parcelable {

    public String action;
    public Map<String, Object> extras;

    public Message() {
        this.action = null;
        this.extras = null;
    }

    public Message(String action) {
        this.action = action;
        this.extras = null;
    }

    public Message(String action, Map<String, Object> extras) {
        this.action = action;
        this.extras = extras;
    }

    @Override
    public int describeContents() {
        return 1;
    }

    @Override
    public void writeToParcel(Parcel parcel, int flags) {
        parcel.writeValue(this.action);
        parcel.writeValue(this.extras);
    }

    public static final Parcelable.Creator<Message> CREATOR = new Parcelable.Creator<Message>() {
        @Override
        public Message createFromParcel(Parcel parcel) {
            Message message = new Message();
            message.action = (String) parcel.readValue(getClass().getClassLoader());
            message.extras = (Map<String, Object>) parcel.readValue(getClass().getClassLoader());
            return message;
        }

        @Override
        public Message[] newArray(int size) {
            return new Message[size];
        }
    };
}
