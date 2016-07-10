import React from 'react';

import TitleBar from '../components/TitleBar';

const Turn = React.createClass({
    render(){
        return (
            <div>
                <TitleBar title="Games" back={"/games/"} />

            </div>
        )
    }
});

export default Turn;
